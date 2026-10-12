import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { WorktreeService } from '../git/worktree.ts';
import { AppError } from '../shared/errors.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { EditorService, completionCandidates } from './editor.ts';
import { withFileLocks } from '../shared/fsx.ts';
import { gitOk } from '../git/git.ts';

test('editor atomic save, stale revisions, readonly and symlink boundaries', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const root = ws.projectDir('P'); const file = path.join(root, 'edit.txt');
  await fs.writeFile(file, 'before');
  const first = await editor.read('P', '', 'edit.txt');
  const saved = await editor.save('P', '', 'edit.txt', 'after', first.revision);
  assert.equal(await fs.readFile(file, 'utf8'), 'after'); assert.notEqual(saved.revision, first.revision);
  await fs.writeFile(file, 'external');
  await assert.rejects(editor.save('P', '', 'edit.txt', 'overwrite', saved.revision), (error: unknown) => error instanceof AppError && error.detail === 'editor_conflict');
  assert.equal(await fs.readFile(file, 'utf8'), 'external');
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  const binary = await editor.read('P', '', 'binary.dat'); assert.equal(binary.binary, true);
  await assert.rejects(editor.save('P', '', 'binary.dat', 'x', binary.revision));
  await fs.writeFile(path.join(root, 'medium.ts'), 'x'.repeat(512 * 1024 + 1));
  const medium = await editor.read('P', '', 'medium.ts'); assert.equal(medium.truncated, false);
  await editor.save('P', '', 'medium.ts', medium.text, medium.revision);
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(2_097_152));
  const large = await editor.read('P', '', 'large.txt'); assert.equal(large.truncated, true);
  await assert.rejects(editor.save('P', '', 'large.txt', 'x', large.revision));
  await fs.symlink(file, path.join(root, 'link.txt'));
  await assert.rejects(editor.read('P', '', 'link.txt'));
  await assert.rejects(editor.read('P', '', '../edit.txt'));
  await fs.writeFile(path.join(root, '.env'), 'SECRET=private'); await assert.rejects(editor.read('P', '', '.env'));
  editor.dispose();
}));

test('editor budget accounts for JSON escaping and maps language IDs', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {}, 20000);
  try {
    await fs.writeFile(path.join(ws.projectDir('P'), 'control.txt'), '\u0001'.repeat(3000));
    const control = await editor.read('P', '', 'control.txt'); assert.equal(control.readonly, true);
    await assert.rejects(editor.save('P', '', control.path, control.text, control.revision));
    for (const [name, language] of Object.entries({ 'a.mjs': 'javascript', 'a.kt': 'kotlin', 'a.yml': 'yaml', Dockerfile: 'dockerfile', 'a.sh': 'shellscript', 'a.vue': 'html' })) {
      await fs.writeFile(path.join(ws.projectDir('P'), name), 'sample');
      assert.equal((await editor.read('P', '', name)).language, language);
    }
  } finally { editor.dispose(); }
}));

test('editor CRUD, folder revisions and preview-bound multidocument replacement', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const root = ws.projectDir('P');
  try {
    await editor.mutate('P', '', { action: 'createFolder', path: 'src' });
    const scope = await editor.scope('P', '', ws.root);
    assert.match(scope.scope, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await editor.scope('P', '', ws.root), scope);
    assert.notEqual((await editor.scope('P', '', path.join(root, 'src'))).scope, scope.scope, 'same project IDs and body must not share recovery across workspace roots');
    for (const name of ['a.txt', 'b.txt']) {
      await editor.mutate('P', '', { action: 'createFile', path: `src/${name}` });
      const document = await editor.read('P', '', `src/${name}`);
      await editor.save('P', '', document.path, 'one needle two needle', document.revision);
    }
    const found = await editor.search('P', '', 'needle');
    assert.equal(found.hits.length, 4); assert.deepEqual(new Set(found.hits.map(hit => hit.path)), new Set(['src/a.txt', 'src/b.txt']));
    const documents = await Promise.all(['src/a.txt', 'src/b.txt'].map(file => editor.read('P', '', file)));
    const changes = documents.map(document => ({ path: document.path, revision: document.revision, text: document.text.replaceAll('needle', 'replacement') }));
    await fs.writeFile(path.join(root, 'src/b.txt'), 'outside change');
    await assert.rejects(editor.apply('P', '', changes), (error: unknown) => error instanceof AppError && error.detail === 'editor_conflict');
    assert.equal(await fs.readFile(path.join(root, 'src/a.txt'), 'utf8'), 'one needle two needle');
    changes[1] = { ...changes[1]!, revision: (await editor.read('P', '', 'src/b.txt')).revision };
    await editor.apply('P', '', changes);
    for (const file of ['a.txt', 'b.txt']) assert.equal(await fs.readFile(path.join(root, 'src', file), 'utf8'), 'one replacement two replacement');
    const revision = await editor.folderRevision('P', '', 'src');
    await assert.rejects(editor.mutate('P', '', { action: 'delete', path: 'src', revision: revision.revision }));
    await editor.mutate('P', '', { action: 'createFolder', path: 'src/sub' });
    // A folder moved under itself is refused up front, including through a case-variant path on case-insensitive disks.
    const caseInsensitive = await fs.access(path.join(root, 'SRC')).then(() => true, () => false);
    for (const destination of ['src/sub/moved', 'src/moved', ...(caseInsensitive ? ['SRC/sub/moved'] : [])]) await assert.rejects(editor.mutate('P', '', { action: 'rename', path: 'src', destination, confirmation: 'src', revision: (await editor.folderRevision('P', '', 'src')).revision }), (error: unknown) => error instanceof AppError && error.detail === 'editor_move_into_self', destination);
    await fs.rmdir(path.join(root, 'src/sub'));
    await editor.mutate('P', '', { action: 'rename', path: 'src', destination: 'renamed', confirmation: 'src', revision: (await editor.folderRevision('P', '', 'src')).revision });
    assert.equal(await fs.readFile(path.join(root, 'renamed/a.txt'), 'utf8'), 'one replacement two replacement');
    const stale = await editor.folderRevision('P', '', 'renamed');
    await fs.writeFile(path.join(root, 'renamed/a.txt'), 'changed');
    await assert.rejects(editor.mutate('P', '', { action: 'delete', path: 'renamed', confirmation: 'renamed', revision: stale.revision }));
    await fs.writeFile(path.join(root, 'renamed/.env'), 'secret');
    await assert.rejects(editor.folderRevision('P', '', 'renamed'));
    await assert.rejects(editor.mutate('P', '', { action: 'createFile', path: '.env' }));
    await fs.symlink(path.join(root, 'renamed'), path.join(root, 'link'));
    await assert.rejects(editor.mutate('P', '', { action: 'createFile', path: 'link/new.txt' }));
    await fs.rm(path.join(root, 'renamed/.env'));
    await editor.mutate('P', '', { action: 'delete', path: 'renamed', confirmation: 'renamed', revision: (await editor.folderRevision('P', '', 'renamed')).revision });
    await assert.rejects(fs.stat(path.join(root, 'renamed')));
  } finally { editor.dispose(); }
}));

test('renaming only the letter case works on case-insensitive file systems and still refuses other existing files', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const root = ws.projectDir('P');
  try {
    await editor.mutate('P', '', { action: 'createFile', path: 'readme.md' });
    await editor.mutate('P', '', { action: 'createFile', path: 'other.md' });
    const rename = async (from: string, to: string) => editor.mutate('P', '', { action: 'rename', path: from, destination: to, confirmation: from, revision: (await editor.read('P', '', from)).revision });
    await rename('readme.md', 'README.md');
    assert.deepEqual((await fs.readdir(root)).filter(name => /\.md$/i.test(name) && name !== 'AGENTS.md' && name !== 'CLAUDE.md' && name !== 'PROJECT.md').sort(), ['README.md', 'other.md']);
    await assert.rejects(rename('README.md', 'other.md'), (error: unknown) => error instanceof AppError && error.detail === 'editor_conflict');
    assert.equal(await fs.readFile(path.join(root, 'other.md'), 'utf8'), '');
  } finally { editor.dispose(); }
}));

test('a file without write permission opens read-only and is never replaced by a save', { skip: process.getuid?.() === 0 && 'root bypasses file permissions' }, () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const file = path.join(ws.projectDir('P'), 'generated.txt');
  try {
    await editor.mutate('P', '', { action: 'createFile', path: 'generated.txt' });
    const writable = await editor.read('P', '', 'generated.txt');
    await fs.chmod(file, 0o444);
    const document = await editor.read('P', '', 'generated.txt');
    assert.equal(document.readonly, true);
    // Replacing the file through a temporary rename would otherwise ignore its read-only mode.
    await assert.rejects(editor.save('P', '', 'generated.txt', 'changed', document.revision), (error: unknown) => error instanceof AppError && error.detail === 'editor_not_writable');
    await assert.rejects(editor.apply('P', '', [{ path: 'generated.txt', revision: writable.revision, text: 'changed' }]), (error: unknown) => error instanceof AppError && error.detail === 'editor_not_writable');
    assert.equal(await fs.readFile(file, 'utf8'), '');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o444);
  } finally { await fs.chmod(file, 0o644).catch(() => undefined); editor.dispose(); }
}));

test('creating, renaming or deleting inside a folder without write permission is refused, not an internal error', { skip: process.getuid?.() === 0 && 'root bypasses file permissions' }, () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const folder = path.join(ws.projectDir('P'), 'locked');
  const denied = (error: unknown) => error instanceof AppError && error.detail === 'editor_not_writable';
  try {
    await editor.mutate('P', '', { action: 'createFolder', path: 'locked' });
    await editor.mutate('P', '', { action: 'createFile', path: 'locked/kept.txt' });
    await fs.chmod(folder, 0o555);
    await assert.rejects(editor.mutate('P', '', { action: 'createFile', path: 'locked/new.txt' }), denied);
    const revision = (await editor.read('P', '', 'locked/kept.txt')).revision;
    await assert.rejects(editor.mutate('P', '', { action: 'rename', path: 'locked/kept.txt', destination: 'locked/moved.txt', confirmation: 'locked/kept.txt', revision }), denied);
    await assert.rejects(editor.mutate('P', '', { action: 'delete', path: 'locked/kept.txt', confirmation: 'locked/kept.txt', revision }), denied);
    assert.deepEqual(await fs.readdir(folder), ['kept.txt']);
  } finally { await fs.chmod(folder, 0o755).catch(() => undefined); editor.dispose(); }
}));

test('completion keeps the best 200 matches for the typed prefix instead of refusing large server lists', () => {
  // TypeScript answers with every global; 1000 unrelated globals plus locals must not fail the request.
  const globals = Array.from({ length: 1000 }, (_, i) => ({ label: `global${i}`, sortText: '15' }));
  const items = [...globals, { label: 'documentTitle', sortText: '11' }, { label: 'getElementById', sortText: '15' }, { label: 'docs', sortText: '11', filterText: 'docs' }, { label: 'x', filterText: 'nodoc', sortText: '0' }];
  const labels = (line: string) => (completionCandidates(items, `const a = 1;\n${line}`, 1, line.length) as { label: string }[]).map(item => item.label);
  assert.deepEqual(labels('  doc'), ['documentTitle', 'docs', 'x'], 'prefix matches first, then subsequence matches; sortText orders each group');
  assert.deepEqual(labels('gEBI'), ['getElementById'], 'case-insensitive subsequence keeps abbreviations CodeMirror would match');
  const bare = labels('');
  assert.equal(bare.length, 200);
  assert.deepEqual(bare.slice(0, 3), ['x', 'documentTitle', 'docs'], 'with no prefix, server sortText decides the kept 200');
  assert.throws(() => completionCandidates(Array.from({ length: 20001 }, () => ({ label: 'a' })), '', 0, 0), (error: unknown) => error instanceof AppError && error.code === 'too_large');
});

test('editor LSP exposes completion hover formatting rename actions and project diagnostics', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  for (const name of ['a.ts', 'b.ts']) await fs.writeFile(path.join(ws.projectDir('P'), name), 'old');
  const script = String.raw`
    let buffer = Buffer.alloc(0);
    let documentUri;
    const send = message => { const body = JSON.stringify({jsonrpc:'2.0', ...message}); process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body); };
    const edits = [{range:{start:{line:0,character:0},end:{line:0,character:3}},newText:'new'}];
    process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer,chunk]); for (;;) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,end).toString())[1]);
      if (buffer.length < end+4+size) return;
      const message = JSON.parse(buffer.subarray(end+4,end+4+size).toString()); buffer=buffer.subarray(end+4+size);
      if (!message.id) continue;
      const uri = message.params.textDocument?.uri ?? documentUri;
      if (uri) documentUri = uri;
      let result = null;
      if (message.method==='initialize') result={capabilities:{}};
      else if (message.method==='textDocument/completion') result=[{label:'new',insertText:'new'}];
      else if (message.method==='textDocument/hover') result={contents:{kind:'markdown',value:'symbol information'}};
      else if (message.method==='textDocument/formatting') result=message.params.options.tabSize === 7 ? [{...edits[0],newText:message.params.options.tabSize+':'+message.params.options.insertSpaces+'\n'}] : edits;
      else if (message.method==='textDocument/rename') result={changes:{[uri]:edits,[uri.replace(/a\.ts$/,'b.ts')]:edits}};
      else if (message.method==='textDocument/codeAction') result=[{title:'Fix',edit:{changes:{[uri]:edits}}}];
      else if (message.method==='textDocument/diagnostic') result={items:[{range:{start:{line:0,character:0}},message:'problem',severity:2}]};
      else if (message.method==='textDocument/documentSymbol') result=[{name:'outer',kind:12,selectionRange:{start:{line:0,character:0}},children:[{name:'inner',kind:13,selectionRange:{start:{line:0,character:1}}}]}];
      else if (message.method==='workspace/symbol') result=[{name:'safe',kind:12,location:{uri,range:{start:{line:0,character:0}}}},{name:'secret',kind:12,location:{uri:uri.replace(/a\.ts$/,'.env'),range:{start:{line:0,character:0}}}}];
      send({id:message.id,result});
    }});
  `;
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, { typescript: [process.execPath, '-e', script] });
  try {
    assert.equal((await editor.language('P', '', 'a.ts', 'old', 0, 0, 'completion')).suggestions?.[0]?.insertText, 'new');
    assert.equal((await editor.language('P', '', 'a.ts', 'old', 0, 0, 'hover')).hover, 'symbol information');
    assert.equal((await editor.language('P', '', 'a.ts', 'old', 0, 0, 'format')).changes?.[0]?.text, 'new');
    await fs.writeFile(path.join(ws.projectDir('P'), '.editorconfig'), '[*.ts]\nindent_size = 7\nindent_style = tab\nend_of_line = crlf\n');
    assert.equal((await editor.language('P', '', 'a.ts', 'old', 0, 0, 'format')).changes?.[0]?.text, '7:false\r\n');
    await fs.unlink(path.join(ws.projectDir('P'), '.editorconfig'));
    assert.equal((await editor.language('P', '', 'a.ts', 'old', 0, 0, 'codeActions')).actions?.[0]?.changes[0]?.text, 'new');
    assert.deepEqual((await editor.language('P', '', 'a.ts', 'old', 0, 0, 'documentSymbols')).symbols?.map(item => [item.name, item.container]), [['outer', undefined], ['inner', 'outer']]);
    assert.deepEqual((await editor.language('P', '', 'a.ts', 'old', 0, 0, 'workspaceSymbols', 'safe')).symbols?.map(item => item.name), ['safe']);
    assert.equal((await editor.problems('P', '')).length, 2);
    await assert.rejects(editor.language('P', '', 'a.ts', 'unsaved', 0, 0, 'rename', 'new'));
    const rename = await editor.language('P', '', 'a.ts', 'old', 0, 0, 'rename', 'new');
    assert.equal(rename.changes?.length, 2);
    await editor.apply('P', '', rename.changes!);
    for (const name of ['a.ts', 'b.ts']) assert.equal(await fs.readFile(path.join(ws.projectDir('P'), name), 'utf8'), 'new');
  } finally { editor.dispose(); }
}));

test('editor save waits for the main repository mutation lock before resolving a task target', t => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: 100000 });
  await fs.writeFile(path.join(ws.projectDir('P'), 'edit.txt'), 'before');
  const task = await tasks.create('P', { title: 'isolated' });
  const copy = await worktree.prepare('P', task.id);
  const editor = new EditorService(worktree, tasks, {});
  const first = await editor.read('P', task.id, 'edit.txt');
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const mutation = withFileLocks([await fs.realpath(ws.projectDir('P'))], async () => {
    entered.resolve(); await release.promise;
    await fs.writeFile(path.join(copy, 'edit.txt'), 'mutation');
  });
  await entered.promise;
  const originalGet = tasks.get.bind(tasks);
  let resolvedTarget = false;
  tasks.get = async (project, id) => { resolvedTarget = true; return originalGet(project, id); };
  const canonicalized = Promise.withResolvers<void>();
  const originalRealpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', async (file: string) => {
    const canonical = await originalRealpath(file);
    canonicalized.resolve();
    return canonical;
  });
  const save = editor.save('P', task.id, 'edit.txt', 'overwrite', first.revision);
  const rejected = assert.rejects(save, (error: unknown) => error instanceof AppError && error.detail === 'editor_conflict');
  try {
    await canonicalized.promise;
    // Allow save's realpath continuation to reach the held lock, without a timed sleep.
    await Promise.resolve();
    assert.equal(resolvedTarget, false, 'task target must not resolve outside the main mutation lock');
  } finally { release.resolve(); await mutation; }
  await rejected;
  assert.equal(await fs.readFile(path.join(copy, 'edit.txt'), 'utf8'), 'mutation');
  editor.dispose();
}));

test('initialized LSP death evicts documents, does not retry, and a later request opens them anew', () => withTmpWorkspace(async (ws, dir) => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const log = path.join(dir, 'lsp-events.jsonl');
  const script = String.raw`
    const fs = require('node:fs');
    const log = process.argv[1];
    const previous = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const run = previous.filter(event => event.method === 'start').length + 1;
    const record = message => fs.appendFileSync(log, JSON.stringify({ run, ...message }) + '\n');
    const send = message => { const body = JSON.stringify({ jsonrpc: '2.0', ...message }); process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body); };
    record({ method: 'start' });
    let buffer = Buffer.alloc(0);
    process.stdin.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
        if (buffer.length < end + 4 + size) return;
        const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
        buffer = buffer.subarray(end + 4 + size);
        record(message);
        if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
        else if (message.method === 'textDocument/didOpen') send({ method: 'textDocument/publishDiagnostics', params: { uri: message.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 } }, message: 'old process', severity: 1 }] } });
        else if (message.method === 'textDocument/diagnostic' && run === 1) { process.exit(0); }
        else if (message.method === 'textDocument/diagnostic') send({ id: message.id, result: { items: [] } });
        else if (message.method === 'textDocument/references') send({ id: message.id, error: { code: -32603, message: 'request failed' } });
        else if (message.method === 'textDocument/definition') send({ id: message.id, result: [] });
      }
    });
  `;
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, { typescript: [process.execPath, '-e', script, log] });
  const events = async (): Promise<Array<{ run: number; method: string; params?: { textDocument: { uri: string; version: number } } }>> => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const file of ['a.ts', 'b.ts']) await fs.writeFile(path.join(ws.projectDir('P'), file), 'const value = 1;');
  try {
    for (const file of ['a.ts', 'b.ts']) await editor.language('P', '', file, 'const value = 1;', 0, 0, 'definition');
    await assert.rejects(editor.language('P', '', 'a.ts', 'const value = 2;', 0, 0, 'diagnostics'), (error: unknown) => error instanceof AppError);
    assert.equal((await events()).filter(event => event.method === 'start').length, 1, 'failed request must not restart or retry');
    for (const file of ['a.ts', 'b.ts']) assert.deepEqual(await editor.language('P', '', file, 'const value = 3;', 0, 0, 'diagnostics'), { locations: [], diagnostics: [] });
    const reopened = (await events()).filter(event => event.run === 2 && event.method === 'textDocument/didOpen');
    assert.equal(reopened.length, 2);
    assert.deepEqual(reopened.map(event => event.params?.textDocument.version), [1, 1]);
    assert.notEqual(reopened[0]?.params?.textDocument.uri, reopened[1]?.params?.textDocument.uri);
    await assert.rejects(editor.language('P', '', 'a.ts', 'const value = 4;', 0, 0, 'references'));
    await editor.language('P', '', 'a.ts', 'const value = 5;', 0, 0, 'definition');
    const recorded = await events();
    assert.equal(recorded.filter(event => event.method === 'start').length, 2);
    assert.equal(recorded.filter(event => event.method === 'textDocument/references').length, 1);
  } finally { editor.dispose(); }
}));

test('real installed TypeScript LSP: cross-file definition references diagnostics', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks);
  const root = ws.projectDir('P');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'es2025' }, include: ['*.ts'] }));
  await fs.writeFile(path.join(root, 'a.ts'), 'export const value = 123;\n');
  const text = 'import { value } from "./a";\nconst broken: string = value;\n';
  await fs.writeFile(path.join(root, 'b.ts'), text);
  try {
    const definition = await editor.language('P', '', 'b.ts', text, 1, 24, 'definition');
    assert.ok(definition.locations.some(location => location.path === 'a.ts'));
    const references = await editor.language('P', '', 'b.ts', text, 1, 24, 'references');
    assert.ok(references.locations.some(location => location.path === 'b.ts'));
    const diagnostics = await editor.language('P', '', 'b.ts', text, 1, 0, 'diagnostics');
    assert.ok(diagnostics.diagnostics.some(diagnostic => diagnostic.line === 1));
  } finally { editor.dispose(); }
}));

test('isolated file browsing falls back read-only before preparation and after copy clear', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: 100000 });
  const task = await tasks.create('P', { title: 'not started' });
  const file = path.join(ws.projectDir('P'), 'view.txt');
  await fs.writeFile(file, 'main content');
  const editor = new EditorService(worktree, tasks, {});
  try {
    const before = await editor.read('P', task.id, 'view.txt');
    assert.equal(before.text, 'main content');
    assert.equal(before.readonly, true);
    await assert.rejects(editor.save('P', task.id, 'view.txt', 'wrong main edit', before.revision), { detail: 'editor_readonly' });
    const copy = await worktree.prepare('P', task.id);
    const prepared = await editor.read('P', task.id, 'view.txt');
    assert.equal(prepared.readonly, false);
    await editor.save('P', task.id, 'view.txt', 'copy content', prepared.revision);
    assert.equal(await fs.readFile(file, 'utf8'), 'main content');
    assert.equal(await fs.readFile(path.join(copy, 'view.txt'), 'utf8'), 'copy content');
    await worktree.abandon('P', task.id);
    await worktree.copyclear('P', task.id);
    const cleared = await editor.read('P', task.id, 'view.txt');
    assert.equal(cleared.text, 'main content');
    assert.equal(cleared.readonly, true);
  } finally { editor.dispose(); }
}));

test('Problems preserves dirty snapshots across language clients and close restores disk', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P');
  const savedTs = 'export const tsValue: number = 1;\n';
  const savedJs = '/** @type {number} */\nexport const jsValue = 1;\n';
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, allowJs: true, checkJs: true, module: 'esnext', target: 'es2025' }, include: ['*.ts', '*.js'] }));
  await fs.writeFile(path.join(root, 'a.ts'), savedTs);
  await fs.writeFile(path.join(root, 'b.js'), savedJs);
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks);
  try {
    await editor.language('P', '', 'a.ts', 'export const tsValue: number = "wrong";\n', 0, 0, 'diagnostics');
    await editor.language('P', '', 'b.js', '/** @type {number} */\nexport const jsValue = "wrong";\n', 1, 0, 'diagnostics');
    const problems = await editor.problems('P', '');
    assert.ok(problems.some(item => item.path === 'a.ts' && item.severity === 1));
    assert.ok(problems.some(item => item.path === 'b.js' && item.severity === 1));
    await editor.close('P', '', 'a.ts');
    const afterClose = await editor.problems('P', '');
    assert.ok(!afterClose.some(item => item.path === 'a.ts' && item.severity === 1));
    assert.ok(afterClose.some(item => item.path === 'b.js' && item.severity === 1));
    assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), savedTs);
  } finally { editor.dispose(); }
}));

test('focused revisions and three-way merge preserve disk and reject stale or unsafe paths', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const file = path.join(ws.projectDir('P'), 'a.txt');
  try {
    await fs.writeFile(file, 'one\ntwo\nthree\n');
    const base = await editor.read('P', '', 'a.txt');
    assert.equal((await editor.revisions('P', '', [{ path: 'a.txt', revision: base.revision }])).changes[0]?.status, 'unchanged');
    await fs.writeFile(file, 'one\ntwo\nremote\n');
    const remote = await editor.read('P', '', 'a.txt');
    assert.equal((await editor.revisions('P', '', [{ path: 'a.txt', revision: base.revision }])).changes[0]?.status, 'changed');
    const merged = await editor.merge('P', '', 'a.txt', base.text, 'local\ntwo\nthree\n', remote.revision);
    assert.equal(merged.text, 'local\ntwo\nremote\n'); assert.equal(merged.conflicts, false);
    const conflict = await editor.merge('P', '', 'a.txt', base.text, 'one\ntwo\nlocal\n', remote.revision);
    assert.equal(conflict.conflicts, true); assert.match(conflict.text, /<<<<<<< local/u);
    assert.equal(await fs.readFile(file, 'utf8'), remote.text);
    await assert.rejects(editor.merge('P', '', 'a.txt', base.text, 'local', base.revision));
    await fs.symlink(file, path.join(ws.projectDir('P'), 'link.txt'));
    assert.equal((await editor.revisions('P', '', [{ path: 'link.txt', revision: '' }, { path: '.env', revision: '' }])).changes.every(item => item.status === 'missing'), true);
    await fs.unlink(file);
    assert.equal((await editor.revisions('P', '', [{ path: 'a.txt', revision: remote.revision }])).changes[0]?.status, 'missing');
    await assert.rejects(editor.revisions('P', '', Array.from({ length: 51 }, (_, i) => ({ path: `${i}.txt`, revision: '' }))));
  } finally { editor.dispose(); }
}));

test('format preferences resolve nested EditorConfig within scope and reject symlink configuration', () => withTmpWorkspace(async (ws, directory) => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const root = ws.projectDir('P');
  try {
    await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.ts'), 'old');
    assert.equal((await editor.preferences('P', '', 'src/a.ts')).source, 'default');
    await fs.writeFile(path.join(root, '.editorconfig'), '[*.ts]\nindent_size = 8\nend_of_line = crlf\n');
    await fs.writeFile(path.join(root, 'src/.editorconfig'), 'root = true\n[*.ts]\nindent_size = 3\n');
    assert.deepEqual(await editor.preferences('P', '', 'src/a.ts'), { tabSize: 3, insertSpaces: true, eol: 'preserve', source: 'editorconfig' });
    await fs.unlink(path.join(root, 'src/.editorconfig'));
    assert.equal((await editor.preferences('P', '', 'src/a.ts')).tabSize, 8);
    const outside = path.join(directory, 'outside-config'); await fs.writeFile(outside, '[*]\nindent_size = 9\n');
    await fs.symlink(outside, path.join(root, 'src/.editorconfig'));
    await assert.rejects(editor.preferences('P', '', 'src/a.ts'));
  } finally { editor.dispose(); }
}));

test('a tracked file deleted from the working tree reads as missing, not as an internal error', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const root = ws.projectDir('P');
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src', 'gone.ts'), 'x'); await fs.writeFile(path.join(root, 'src', 'kept.ts'), 'y');
  await gitOk(root, ['add', 'src/gone.ts', 'src/kept.ts']);
  await fs.rm(path.join(root, 'src', 'gone.ts'));
  await assert.rejects(editor.read('P', '', 'src/gone.ts'), (error: unknown) => error instanceof AppError && error.status === 404 && error.detail === 'file_missing');
  assert.equal((await editor.read('P', '', 'src/kept.ts')).text, 'y');
  // Deleting the folder still works although one of its tracked files is already gone.
  await editor.mutate('P', '', { action: 'delete', path: 'src', confirmation: 'src', revision: (await editor.folderRevision('P', '', 'src')).revision });
  assert.equal(await fs.stat(path.join(root, 'src')).catch(() => null), null);
  editor.dispose();
}));

test('folder lookups and new files under a folder that does not exist are not found, not internal errors', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const editor = new EditorService(new WorktreeService({ ws, projects, tasks, diffBytes: 100000 }), tasks, {});
  const missing = (error: unknown) => error instanceof AppError && error.status === 404;
  await assert.rejects(editor.folderRevision('P', '', 'gone'), missing);
  await assert.rejects(editor.mutate('P', '', { action: 'createFile', path: 'gone/new.txt' }), missing);
  await assert.rejects(editor.mutate('P', '', { action: 'delete', path: 'gone', confirmation: 'gone', revision: 'x' }), missing);
  editor.dispose();
}));
