import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { WorktreeService } from '../git/worktree.ts';
import { git, gitOk, isLocalSecret } from '../git/git.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { EditorDocument, EditorLocation, EditorDiagnostic } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { isInside, pathExists, withFileLocks } from '../shared/fsx.ts';
import { LanguageClient } from './editor-lsp.ts';
import type { EditorAction, EditorActionResult, EditorChange, EditorMutation, EditorSearchResult, EditorProblem, EditorRevisionResult, EditorMergeResult } from '../shared/editor-workbench.ts';

const LANGUAGE: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript', json: 'json', py: 'python', rs: 'rust', go: 'go', css: 'css', scss: 'scss', html: 'html', vue: 'html', md: 'markdown', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin', php: 'php', sql: 'sql', xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', rb: 'ruby', swift: 'swift', lua: 'lua', ini: 'ini' };
export class EditorService {
  private clients = new Map<string, LanguageClient>();
  private versions = new Map<string, number>();
  private snapshots = new Map<string, { root: string; uri: string; language: string; text: string }>();
  readonly commands: Record<string, string[]>;
  private readonly MAX: number;
  private readonly bodyBytes: number;
  private readonly worktree: WorktreeService;
  private readonly tasks: TaskLedger;
  constructor(worktree: WorktreeService, tasks: TaskLedger, commands?: Record<string, string[]>, bodyBytes = 2_097_152) {
    this.worktree = worktree; this.tasks = tasks;
    this.bodyBytes = bodyBytes;
    this.MAX = Math.max(0, Math.min(8 * 1024 * 1024, bodyBytes - 8192));
    this.commands = commands ?? this.environmentCommands();
  }
  private environmentCommands(): Record<string, string[]> {
    const configured: unknown = JSON.parse(process.env.YUMEEWADE_LSP_COMMANDS ?? '{}');
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('YUMEEWADE_LSP_COMMANDS 必須是 languageId → argv 陣列的 JSON');
    const commands: Record<string, string[]> = {};
    for (const [language, argv] of Object.entries(configured)) {
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === 'string' && arg.length > 0)) throw new Error('LSP command 必須是非空字串陣列');
      commands[language] = argv as string[];
    }
    // TypeScript 7 的已安裝原生工具支援 --lsp -stdio（不是舊版 tsserver）。
    try {
      const require = createRequire(import.meta.url);
      const pkg = require.resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`);
      const exe = path.join(path.dirname(pkg), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
      for (const language of ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']) commands[language] ??= [exe, '--lsp', '-stdio'];
    } catch { /* 未安裝的打包環境明確回 unavailable；可配置本機 server。 */ }
    return commands;
  }
  private async root(project: string, task: string): Promise<{ root: string; readonly: boolean }> {
    const repo = await this.worktree.bodyPath(project);
    if (!task) return { root: await fs.realpath(repo), readonly: false };
    const record = await this.tasks.get(project, task);
    if (record.workspace === 'direct') return { root: await fs.realpath(repo), readonly: false };
    if (!record.workdir || !(await pathExists(path.join(record.workdir, '.git')))) return { root: await fs.realpath(repo), readonly: true };
    return { root: await fs.realpath(record.workdir), readonly: false };
  }
  async scope(project: string, task: string, workspace: string): Promise<{ scope: string }> {
    const { root } = await this.root(project, task);
    const body = await fs.realpath(await this.worktree.bodyPath(project));
    return { scope: createHash('sha256').update(JSON.stringify([await fs.realpath(workspace), body, root, project, task])).digest('hex') };
  }
  private async files(root: string): Promise<string[]> {
    return (await gitOk(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(file => !!file && !isLocalSecret(file));
  }
  private async target(project: string, task: string, relative: string, listed = true): Promise<{ root: string; file: string; readonly: boolean }> {
    if (!relative || relative.length > 1000 || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.' || part === '.git' || part === '.ai' || isLocalSecret(part)) || path.isAbsolute(relative)) throw new AppError('not_found', 'file_missing');
    const { root, readonly } = await this.root(project, task);
    if (listed && !(await this.files(root)).includes(relative)) throw new AppError('not_found', 'file_missing');
    let file = root;
    for (const part of relative.split('/')) { file = path.join(file, part); if ((await fs.lstat(file)).isSymbolicLink()) throw new AppError('not_found', 'file_missing'); }
    if (!isInside(root, await fs.realpath(file))) throw new AppError('not_found', 'file_missing');
    return { root, file, readonly };
  }
  private async document(file: string, relative: string, readonly = false): Promise<EditorDocument> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AppError('not_found', 'file_missing');
      const bytes = Buffer.alloc(Math.min(stat.size, this.MAX));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const body = bytes.subarray(0, bytesRead);
      let text = ''; let binary = body.includes(0);
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { binary = true; }
      const revision = createHash('sha256').update(body).update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex');
      const language = LANGUAGE[path.extname(relative).slice(1).toLowerCase()] ?? (/dockerfile$/i.test(relative) ? 'dockerfile' : 'plaintext');
      return { path: relative, text: binary ? '' : text, size: stat.size, binary, truncated: stat.size > this.MAX, revision, language, languageAvailable: !!this.commands[language], readonly: readonly || Buffer.byteLength(JSON.stringify(text)) > this.bodyBytes - 8192 };
    } finally { await handle.close(); }
  }
  async read(project: string, task: string, relative: string): Promise<EditorDocument> { const { file, readonly } = await this.target(project, task, relative); return this.document(file, relative, readonly); }
  async revisions(project: string, task: string, documents: { path: string; revision: string }[]): Promise<EditorRevisionResult> {
    if (documents.length > 50 || new Set(documents.map(item => item.path)).size !== documents.length) throw new AppError('bad_request');
    const changes: EditorRevisionResult['changes'] = [];
    for (const item of documents) {
      try {
        const document = await this.read(project, task, item.path);
        changes.push({ path: item.path, status: document.revision === item.revision ? 'unchanged' : 'changed', revision: document.revision });
      } catch (error) {
        if ((error instanceof AppError && error.code === 'not_found') || (error as NodeJS.ErrnoException).code === 'ENOENT') changes.push({ path: item.path, status: 'missing' });
        else throw error;
      }
    }
    return { changes };
  }
  async merge(project: string, task: string, relative: string, base: string, local: string, revision: string): Promise<EditorMergeResult> {
    for (const text of [base, local]) if (typeof text !== 'string' || Buffer.byteLength(text) > this.MAX || text.includes('\0')) throw new AppError('too_large');
    const remote = await this.read(project, task, relative);
    if (remote.binary || remote.truncated || remote.readonly) throw new AppError('bad_request', 'editor_readonly');
    if (remote.revision !== revision) throw new AppError('conflict', 'editor_conflict');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yumeewade-merge-'));
    try {
      await Promise.all([['local', local], ['base', base], ['remote', remote.text]].map(([name, text]) => fs.writeFile(path.join(directory, name!), text!, { mode: 0o600 })));
      const result = await git(directory, ['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'remote', 'local', 'base', 'remote'], { maxBytes: this.MAX, timeoutMs: 15000 });
      if (result.truncated || result.code < 0 || result.code > 127) throw new AppError('unavailable');
      if (Buffer.byteLength(JSON.stringify(result.stdout)) > this.bodyBytes - 8192) throw new AppError('too_large');
      return { text: result.stdout, revision, conflicts: result.code !== 0 };
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  async image(project: string, task: string, relative: string): Promise<{ bytes: Buffer; contentType: string }> {
    const { file } = await this.target(project, task, relative);
    const contentType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' } as Record<string, string>)[path.extname(relative).toLowerCase()];
    if (!contentType) throw new AppError('bad_request');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AppError('not_found', 'file_missing');
      const limit = 20 * 1024 * 1024;
      if (stat.size > limit) throw new AppError('too_large');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if ((await handle.stat()).size > limit) throw new AppError('too_large');
      return { bytes: bytes.subarray(0, offset), contentType };
    } finally { await handle.close(); }
  }
  async save(project: string, task: string, relative: string, text: string, revision: string): Promise<EditorDocument> {
    if (Buffer.byteLength(text) > this.MAX || Buffer.byteLength(JSON.stringify(text)) > this.bodyBytes - 8192 || text.includes('\0')) throw new AppError('too_large');
    // Worktree mutations lock the canonical main repository, including task copies.
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    return withFileLocks([repo], async () => {
    const target = await this.target(project, task, relative);
    if (target.readonly) throw new AppError('bad_request', 'editor_readonly');
    return withFileLocks([target.file], async () => {
      const current = await this.document(target.file, relative);
      if (current.binary || current.truncated) throw new AppError('bad_request', 'editor_readonly');
      if (current.revision !== revision) throw new AppError('conflict', 'editor_conflict');
      const stat = await fs.stat(target.file);
      const tmp = path.join(path.dirname(target.file), `.editor-${randomUUID()}.tmp`);
      const handle = await fs.open(tmp, 'wx', stat.mode & 0o777);
      try {
        await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close();
        const checked = await this.target(project, task, relative);
        if (checked.file !== target.file || (await this.document(target.file, relative)).revision !== revision) throw new AppError('conflict', 'editor_conflict');
        await fs.rename(tmp, target.file);
      } finally { await handle.close().catch(() => undefined); await fs.rm(tmp, { force: true }); }
      return this.document(target.file, relative);
    });
    });
  }
  async close(project: string, task: string, relative: string): Promise<void> {
    const { root, file } = await this.target(project, task, relative);
    await withFileLocks([file], async () => {
      const uri = pathToFileURL(file).href;
      for (const [clientKey, client] of this.clients) if (clientKey.startsWith(`${root}\0`)) client.closeDocument(uri);
      this.snapshots.delete(`${root}\0${uri}`);
      // Keep the bounded version counter until server eviction so late publications cannot match a reopened buffer.
    });
  }
  async language(project: string, task: string, relative: string, text: string, line: number, character: number, action: EditorAction, newName?: string): Promise<EditorActionResult> {
    const { root, file } = await this.target(project, task, relative);
    return withFileLocks([file], async () => {
    const document = await this.document(file, relative);
    if (document.binary || document.truncated || Buffer.byteLength(text) > this.MAX || Buffer.byteLength(JSON.stringify(text)) > this.bodyBytes - 8192 || text.includes('\0')) throw new AppError('bad_request', 'editor_readonly');
    const command = this.commands[document.language];
    if (!command) throw new AppError('unavailable', 'editor_language_unavailable');
    const key = `${root}\0${document.language}`;
    let client = this.clients.get(key);
    if (!client) {
      if (this.clients.size >= 16) throw new AppError('unavailable');
      const created: LanguageClient = new LanguageClient(command, root, () => this.evictClient(key, created));
      client = created; this.clients.set(key, client);
      try { await client.ready; } catch (error) { client.dispose(); this.evictClient(key, client); throw error; }
      for (const snapshot of this.snapshots.values()) if (snapshot.root === root) {
        const snapshotKey = `${key}\0${snapshot.uri}`;
        const version = (this.versions.get(snapshotKey) ?? 0) + 1;
        this.versions.set(snapshotKey, version);
        client.openDocument(snapshot.uri, snapshot.language, version, snapshot.text);
      }
    }
    try { await client.ready; } catch (error) { client.dispose(); this.evictClient(key, client); throw error; }
    const uri = pathToFileURL(file).href;
    if (!this.snapshots.has(`${root}\0${uri}`) && this.snapshots.size >= 1000) throw new AppError('too_large');
    this.snapshots.set(`${root}\0${uri}`, { root, uri, language: document.language, text });
    for (const [clientKey, active] of this.clients) if (clientKey.startsWith(`${root}\0`)) {
      const snapshotKey = `${clientKey}\0${uri}`;
      if (!this.versions.has(snapshotKey) && this.versions.size >= 16000) throw new AppError('too_large');
      const version = (this.versions.get(snapshotKey) ?? 0) + 1; this.versions.set(snapshotKey, version);
      active.openDocument(uri, document.language, version, text);
    }
    const locations: EditorLocation[] = []; const diagnostics: EditorDiagnostic[] = [];
    if (action === 'completion' || action === 'hover' || action === 'rename' || action === 'format' || action === 'codeActions') {
      const method = action === 'format' ? 'formatting' : action === 'codeActions' ? 'codeAction' : action;
      const result = await client.request(`textDocument/${method}`, { textDocument: { uri }, position: { line, character }, ...(action === 'rename' ? { newName } : {}), ...(action === 'format' ? { options: { tabSize: 2, insertSpaces: true } } : {}), ...(action === 'codeActions' ? { range: { start: { line, character }, end: { line, character } }, context: { diagnostics: [] } } : {}) });
      if (action === 'hover') {
        const value = result as { contents?: unknown } | null;
        const contents = value?.contents;
        const stringify = (item: unknown): string => typeof item === 'string' ? item : item && typeof item === 'object' && 'value' in item && typeof item.value === 'string' ? item.value : '';
        const hover = Array.isArray(contents) ? contents.map(stringify).join('\n') : stringify(contents);
        if (hover.length > 100000) throw new AppError('too_large');
        return { locations, diagnostics, hover };
      }
      if (action === 'completion') {
        const items = Array.isArray(result) ? result : (result as { items?: unknown[] } | null)?.items ?? [];
        if (items.length > 200) throw new AppError('too_large');
        return { locations, diagnostics, suggestions: items.map(value => {
          const item = value as { label: string; detail?: string; insertText?: string; insertTextFormat?: number; textEdit?: { newText: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } }; replace?: { start: { line: number; character: number }; end: { line: number; character: number } } } };
          if (typeof item.label !== 'string' || item.label.length > 1000 || (item.detail?.length ?? 0) > 2000) throw new AppError('bad_request');
          const range = item.textEdit?.range ?? item.textEdit?.replace;
          const offset = (position: { line: number; character: number }): number => {
            const lines = text.split('\n');
            if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) || position.line < 0 || position.line >= lines.length || position.character < 0 || position.character > lines[position.line]!.length) throw new AppError('bad_request');
            return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
          };
          const insertText = item.insertTextFormat === 2 ? item.label : item.textEdit?.newText ?? item.insertText ?? item.label;
          if (typeof insertText !== 'string' || insertText.length > this.MAX) throw new AppError('bad_request');
          return { label: item.label, ...(typeof item.detail === 'string' ? { detail: item.detail } : {}), insertText, ...(range ? { start: offset(range.start), end: offset(range.end) } : {}) };
        }) };
      }
      if (text !== document.text) throw new AppError('conflict', 'editor_conflict');
      if (action === 'codeActions') {
        if (Array.isArray(result) && result.length > 50) throw new AppError('too_large');
        const actions = [];
        for (const item of (Array.isArray(result) ? result : []).slice(0, 50)) {
          const value = item as { title?: string; edit?: unknown };
          if (typeof value.title === 'string' && value.edit) actions.push({ title: value.title, changes: await this.workspaceChanges(project, task, root, value.edit) });
        }
        return { locations, diagnostics, actions };
      }
      return { locations, diagnostics, changes: await this.workspaceChanges(project, task, root, action === 'format' ? { changes: { [uri]: result } } : result) };
    }
    if (action === 'diagnostics') {
      let items: unknown[];
      try { const result = await client.request('textDocument/diagnostic', { textDocument: { uri } }) as { items?: unknown[] }; items = result.items ?? []; }
      catch (error) { if (!client.alive) throw error; items = await client.publishedDiagnostics(uri); }
      if (!Array.isArray(items) || items.length > 1000) throw new AppError('too_large');
      for (const value of items) {
        const item = value as { range?: { start?: { line: number; character: number }; end?: { line: number; character: number } }; message?: string; severity?: number };
        const start = item?.range?.start; const end = item?.range?.end;
        if (!start || !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) || start.line < 0 || start.character < 0 || typeof item.message !== 'string') continue;
        diagnostics.push({ line: start.line, character: start.character, ...(end && Number.isSafeInteger(end.line) && Number.isSafeInteger(end.character) && end.line >= 0 && end.character >= 0 ? { endLine: end.line, endCharacter: end.character } : {}), message: item.message.slice(0, 4000), severity: item.severity ?? 1 });
      }
    } else {
      const result = await client.request(`textDocument/${action}`, { textDocument: { uri }, position: { line, character }, ...(action === 'references' ? { context: { includeDeclaration: true } } : {}) });
      const allowed = new Set(await this.files(root));
      for (const value of result === null ? [] : Array.isArray(result) ? result : [result]) {
        const item = value as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetSelectionRange?: { start: { line: number; character: number } } };
        try { const relative = path.relative(root, fileURLToPath(item.uri ?? item.targetUri!)).split(path.sep).join('/'); const start = (item.range ?? item.targetSelectionRange)!.start; if (allowed.has(relative)) { await this.target(project, task, relative); locations.push({ path: relative, line: start.line, character: start.character }); } } catch { /* 不暴露工作區之外、機密或 symlink 目標。 */ }
      }
    }
    return { locations, diagnostics };
    });
  }
  private async workspaceChanges(project: string, task: string, root: string, value: unknown): Promise<EditorChange[]> {
    if (!value || typeof value !== 'object') return [];
    const edit = value as { changes?: Record<string, unknown[]>; documentChanges?: { textDocument?: { uri: string }; edits?: unknown[] }[] };
    const entries = Object.entries(edit.changes ?? {});
    for (const change of edit.documentChanges ?? []) {
      if (!change.textDocument || !Array.isArray(change.edits)) throw new AppError('bad_request');
      entries.push([change.textDocument.uri, change.edits]);
    }
    if (entries.length > 50) throw new AppError('too_large');
    const output: EditorChange[] = []; const seen = new Set<string>();
    for (const [uri, edits] of entries) {
      const relative = path.relative(root, fileURLToPath(uri)).split(path.sep).join('/');
      if (seen.has(relative)) throw new AppError('bad_request'); seen.add(relative);
      const document = await this.read(project, task, relative);
      if (document.binary || document.truncated || document.readonly || !Array.isArray(edits) || edits.length > 10000) throw new AppError('bad_request', 'editor_readonly');
      const lines = document.text.split('\n');
      const offset = (position: { line: number; character: number }): number => {
        if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) || position.line < 0 || position.line >= lines.length || position.character < 0 || position.character > lines[position.line]!.length) throw new AppError('bad_request');
        return lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
      };
      const ranges = edits.map(item => { const edit = item as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }; if (typeof edit.newText !== 'string') throw new AppError('bad_request'); return { start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText }; }).sort((a, b) => b.start - a.start);
      let text = document.text; let boundary = text.length;
      for (const range of ranges) { if (range.end < range.start || range.end > boundary) throw new AppError('bad_request'); text = text.slice(0, range.start) + range.text + text.slice(range.end); boundary = range.start; }
      if (Buffer.byteLength(text) > this.MAX || text.includes('\0')) throw new AppError('too_large');
      output.push({ path: relative, revision: document.revision, text });
    }
    return output;
  }
  async apply(project: string, task: string, changes: EditorChange[]): Promise<EditorDocument[]> {
    if (!changes.length || changes.length > 50 || new Set(changes.map(change => change.path)).size !== changes.length) throw new AppError('bad_request');
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    return withFileLocks([repo], async () => {
      const targets = await Promise.all(changes.map(change => this.target(project, task, change.path)));
      return withFileLocks(targets.map(target => target.file), async () => {
        const staged: { tmp: string; file: string; backup: string }[] = [];
        let committed = 0;
        try {
          for (let index = 0; index < changes.length; index++) {
            const change = changes[index]!; const target = targets[index]!;
            const current = await this.document(target.file, change.path);
            if (target.readonly || current.binary || current.truncated) throw new AppError('bad_request', 'editor_readonly');
            if (current.revision !== change.revision) throw new AppError('conflict', 'editor_conflict');
            if (Buffer.byteLength(change.text) > this.MAX || change.text.includes('\0')) throw new AppError('too_large');
            const tmp = path.join(path.dirname(target.file), `.editor-${randomUUID()}.tmp`);
            const backup = `${tmp}.backup`;
            staged.push({ tmp, file: target.file, backup });
            await fs.copyFile(target.file, backup, constants.COPYFILE_EXCL);
            const handle = await fs.open(tmp, 'wx', (await fs.stat(target.file)).mode & 0o777);
            try { await handle.writeFile(change.text); await handle.sync(); } finally { await handle.close(); }
          }
          for (let index = 0; index < changes.length; index++) {
            const change = changes[index]!;
            await this.target(project, task, change.path);
            if ((await this.document(targets[index]!.file, change.path)).revision !== change.revision) throw new AppError('conflict', 'editor_conflict');
          }
          for (const stage of staged) { await fs.rename(stage.tmp, stage.file); committed++; }
          return await Promise.all(changes.map((change, index) => this.document(targets[index]!.file, change.path)));
        } catch (error) {
          for (let index = committed - 1; index >= 0; index--) await fs.rename(staged[index]!.backup, staged[index]!.file);
          throw error;
        } finally { for (const stage of staged) { await fs.rm(stage.tmp, { force: true }); await fs.rm(stage.backup, { force: true }); } }
      });
    });
  }
  async search(project: string, task: string, needle: string): Promise<EditorSearchResult> {
    if (!needle || needle.length > 1000) throw new AppError('bad_request');
    const { root } = await this.root(project, task);
    const files = await this.files(root);
    if (files.length > 10000) throw new AppError('too_large');
    const hits: EditorSearchResult['hits'] = []; let scanned = 0; let bytes = 0;
    for (const relative of files) {
      let document: EditorDocument;
      try { document = await this.read(project, task, relative); } catch { continue; }
      if (document.binary || document.truncated) continue;
      bytes += document.size; if (bytes > 32 * 1024 * 1024) throw new AppError('too_large');
      scanned++;
      let offset = 0;
      while ((offset = document.text.indexOf(needle, offset)) >= 0) {
        const before = document.text.slice(0, offset).split('\n'); const line = before.length - 1; const character = before.at(-1)!.length;
        hits.push({ path: relative, revision: document.revision, line, character, end: offset + needle.length, preview: document.text.split('\n')[line]!.slice(0, 500) });
        if (hits.length > 1000) throw new AppError('too_large');
        offset += needle.length;
      }
    }
    return { hits, scanned };
  }
  async folderRevision(project: string, task: string, relative: string): Promise<{ revision: string }> {
    const target = await this.target(project, task, relative, false); const hash = createHash('sha256'); const allowed = new Set(await this.files(target.root)); let count = 0;
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('bad_request');
      hash.update(`${prefix}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}\0`);
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++count > 1000 || entry.isSymbolicLink() || isLocalSecret(entry.name) || entry.name === '.git' || entry.name === '.ai') throw new AppError('bad_request');
        const child = `${prefix}/${entry.name}`; const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file, child);
        else { if (!allowed.has(child)) throw new AppError('bad_request'); const document = await this.document(file, child); hash.update(`${child}:${document.revision}\0`); }
      }
    };
    await walk(target.file, relative); return { revision: hash.digest('hex') };
  }
  async mutate(project: string, task: string, mutation: EditorMutation): Promise<void> {
    const repo = await fs.realpath(await this.worktree.bodyPath(project));
    await withFileLocks([repo], async () => {
      const { root, readonly } = await this.root(project, task); if (readonly) throw new AppError('bad_request', 'editor_readonly');
      const creation = mutation.action === 'createFile' || mutation.action === 'createFolder';
      const validateNew = async (relative: string): Promise<string> => {
        if (!relative || relative.length > 1000 || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.ai' || isLocalSecret(part))) throw new AppError('bad_request');
        const parent = path.posix.dirname(relative);
        if (parent !== '.') await this.target(project, task, parent, false);
        const file = path.join(root, relative);
        if (await pathExists(file)) throw new AppError('conflict', 'editor_conflict');
        return file;
      };
      if (creation) {
        const file = await validateNew(mutation.path);
        if (mutation.action === 'createFolder') await fs.mkdir(file); else { const handle = await fs.open(file, 'wx'); await handle.close(); }
        return;
      }
      if (mutation.confirmation !== mutation.path) throw new AppError('bad_request');
      const target = await this.target(project, task, mutation.path, false);
      const stat = await fs.lstat(target.file);
      if (stat.isDirectory()) {
        if ((await this.folderRevision(project, task, mutation.path)).revision !== mutation.revision) throw new AppError('conflict', 'editor_conflict');
      } else {
        await this.target(project, task, mutation.path);
        if ((await this.document(target.file, mutation.path)).revision !== mutation.revision) throw new AppError('conflict', 'editor_conflict');
      }
      if (mutation.action === 'rename') await fs.rename(target.file, await validateNew(mutation.destination ?? ''));
      else if (mutation.action === 'delete') {
        if (stat.isDirectory()) {
          const staged = path.join(root, `.editor-delete-${randomUUID()}`);
          await fs.rename(target.file, staged);
          try { await fs.rm(staged, { recursive: true }); } catch (error) { await fs.rename(staged, target.file); throw error; }
        } else await fs.unlink(target.file);
      }
      else throw new AppError('bad_request');
    });
  }
  async problems(project: string, task: string): Promise<EditorProblem[]> {
    const { root } = await this.root(project, task); const output: EditorProblem[] = [];
    const paths = (await this.files(root)).filter(relative => !!this.commands[LANGUAGE[path.extname(relative).slice(1)] ?? 'plaintext']);
    if (paths.length > 1000) throw new AppError('too_large');
    const checked = new Set<string>(); let bytes = 0;
    for (const relative of paths) {
      const document = await this.read(project, task, relative);
      if (document.binary || document.truncated) throw new AppError('bad_request', 'editor_readonly');
      bytes += document.size; if (bytes > 32 * 1024 * 1024) throw new AppError('too_large');
      const uri = pathToFileURL((await this.target(project, task, relative)).file).href;
      const text = this.snapshots.get(`${root}\0${uri}`)?.text ?? document.text;
      const result = await this.language(project, task, relative, text, 0, 0, 'diagnostics');
      checked.add(relative);
      for (const diagnostic of result.diagnostics) { output.push({ path: relative, ...diagnostic }); if (output.length > 1000) throw new AppError('too_large'); }
    }
    for (const [key, client] of this.clients) {
      if (!key.startsWith(`${root}\0`)) continue;
      for (const [uri, items] of client.diagnostics) {
        let relative: string;
        try { relative = path.relative(root, fileURLToPath(uri)).split(path.sep).join('/'); await this.target(project, task, relative); } catch { continue; }
        if (checked.has(relative)) continue;
        for (const value of items) {
          const item = value as { range?: { start?: { line: number; character: number } }; message?: string; severity?: number };
          if (!item.range?.start || typeof item.message !== 'string') continue;
          output.push({ path: relative, line: item.range.start.line, character: item.range.start.character, message: item.message.slice(0, 4000), severity: item.severity ?? 1 });
          if (output.length > 1000) throw new AppError('too_large');
        }
      }
    }
    return output;
  }
  private evictClient(key: string, client: LanguageClient): void {
    if (this.clients.get(key) !== client) return;
    this.clients.delete(key);
    for (const versionKey of this.versions.keys()) if (versionKey.startsWith(`${key}\0`)) this.versions.delete(versionKey);
  }
  dispose(): void { for (const client of this.clients.values()) client.dispose(); this.clients.clear(); this.versions.clear(); this.snapshots.clear(); }
}
