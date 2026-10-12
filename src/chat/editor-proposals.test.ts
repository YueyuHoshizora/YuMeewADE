import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditorProposalService, parseProposalEdits, parseProposalFiles } from './editor-proposals.ts';
import { CodexCliProvider } from '../cli/codex.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { Workspace } from '../ledger/workspace.ts';
import { SettingsStore } from '../ledger/settings.ts';
import type { EditorDocument } from '../shared/types.ts';

test('proposal schema rejects paths, overlap, out-of-selection, unchanged edits, and surrogate splits', () => {
  for (const output of ['{"edits":[{"from":0,"to":3,"text":"abc"}]}','{"edits":[{"from":0,"to":1,"text":"x","path":"escape"}]}','{"edits":[{"from":0,"to":2,"text":"x"},{"from":1,"to":3,"text":"y"}]}','{"edits":[]}']) assert.throws(()=>parseProposalEdits(output,'abc',{from:0,to:3}));
  assert.throws(()=>parseProposalEdits('{"edits":[{"from":0,"to":1,"text":"x"}]}','abc',{from:1,to:3}));
  assert.throws(()=>parseProposalEdits('{"edits":[{"from":1,"to":2,"text":"x"}]}','😀',{from:0,to:2}));
});
test('replacement line endings use LF before replay lengths and unchanged checks', () => {
  const edits = parseProposalEdits(JSON.stringify({ edits: [{ from: 0, to: 1, text: 'A\r\nB\r' }, { from: 2, to: 3, text: 'C' }] }), 'a b', { from: 0, to: 3 });
  assert.equal(edits[0]!.text, 'A\nB\n');
  assert.throws(() => parseProposalEdits(JSON.stringify({ edits: [{ from: 0, to: 2, text: 'a\r\n' }] }), 'a\n', { from: 0, to: 2 }));
});
test('multifile parser refuses missing, duplicate, generated paths and aggregate limits', () => {
  const files = ['a.ts','b.ts'].map(path => ({ path, revision: 'r1', text: 'abc', selection: { from: 0, to: 3 } }));
  const row = (path: string) => ({ path, edits: [{ from: 0, to: 1, text: 'A' }] });
  for (const rows of [[row('a.ts')], [row('a.ts'),row('a.ts')], [row('a.ts'),row('../b.ts')]]) assert.throws(() => parseProposalFiles(JSON.stringify({ files: rows }), files));
  assert.throws(() => parseProposalFiles(JSON.stringify({ files: [row('a.ts'),row('a.ts')] }), [files[0]!,files[0]!]));
  assert.throws(() => parseProposalFiles(JSON.stringify({ files: [row('a.ts'),row('b.ts')] }), files.map(file => ({ ...file, text: 'a'.repeat(200_000) }))));
  assert.equal(parseProposalFiles(JSON.stringify({ files: [row('b.ts'),row('a.ts')] }), files).length, 2);
});
test('real exec multifile proposal is isolated, preserves dirty drafts and atomically fails drift', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proposal-fixture-'));
  try {
    const ws = new Workspace(root); await ws.init(); await fs.mkdir(path.join(ws.projectDir('P'), '.ai'), { recursive: true });
    const cli = path.join(root, 'codex-fixture');
    await fs.writeFile(cli, `#!${process.execPath}\nlet prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{if(!process.argv.includes('--sandbox')||!process.argv.includes('read-only')||!process.argv.includes('--ignore-user-config')||!process.argv.includes('--ignore-rules')||!process.argv.includes('--ephemeral')||!process.cwd().includes('yumeewade-proposal-'))process.exit(8);const data=JSON.parse(prompt.slice(prompt.indexOf('\\n')+1));if(data.instruction==='fail')process.exit(7);const files=data.files.map(f=>({path:f.path,edits:[{from:0,to:3,text:'ABCDE'},{from:8,to:11,text:'GHI'}]}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({files})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));});\n`, { mode: 0o755 });
    const provider = new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, command: cli }, []);
    const revisions: Record<string,string> = { 'a.ts': 'r1', 'b.ts': 'r1' };
    let stopping = false;
    const started = Promise.withResolvers<void>(); const continueRun = Promise.withResolvers<void>();
    const service = new EditorProposalService({ providers: { codex: provider }, editor: { read: async (_project, _task, file): Promise<EditorDocument> => ({ path: file, text: 'disk base', revision: revisions[file]!, language: 'typescript', size: 9, binary: false, truncated: false, readonly: false, languageAvailable: false }) }, ws, settings: new SettingsStore(ws, DEFAULT_CONFIG), assertExecutable: async () => {}, isBusy: () => false, beforeRun: async () => { if (stopping) { started.resolve(); await continueRun.promise; } }, concurrentRuns: 2, runSeconds: 30 });
    const files = ['a.ts','b.ts'].map(path => ({ path, revision: 'r1', text: 'abc def ghi', selection: { from: 0, to: 11 } }));
    const input = { files, instruction: 'uppercase', ai: 'codex' };
    await assert.rejects(service.generate('P','', { ...input, files: [files[0]!,files[0]!] }));
    const proposal = await service.generate('P','', input);
    assert.equal(proposal.files[0]!.base, 'disk base'); assert.equal(proposal.files[0]!.local, 'abc def ghi');
    const snapshots = files.map(({ path,revision,text }) => ({ path,revision,text }));
    const rejected = await service.decide('P','',proposal.id, { version: 1, accept: false, snapshots: [snapshots[0]!], target: { path: 'a.ts', edit: '0' } });
    assert.deepEqual(rejected.changes[0]!.edits, []);
    const before = JSON.stringify(await service.history('P',''));
    revisions['b.ts'] = 'r2';
    await assert.rejects(service.decide('P','',proposal.id, { version: 2, accept: true, snapshots }));
    assert.equal(JSON.stringify(await service.history('P','')), before);
    revisions['b.ts'] = 'r1';
    await assert.rejects(service.decide('P','',proposal.id, { version: 2, accept: true, snapshots: [snapshots[0]!, { ...snapshots[1]!, text: 'new dirty text' }] }));
    assert.equal(JSON.stringify(await service.history('P','')), before);
    await assert.rejects(service.decide('P','',proposal.id, { version: 2, accept: true, snapshots: [snapshots[0]!,snapshots[0]!] }));
    const accepted = await service.decide('P','',proposal.id, { version: 2, accept: true, snapshots });
    assert.equal(accepted.proposal.files[0]!.current, 'abc def GHI');
    assert.equal(accepted.proposal.files[1]!.current, 'ABCDE def GHI');
    assert.equal(accepted.proposal.version, 5); assert.equal(accepted.changes.length, 2);
    const recovery = await service.recover('P','',proposal.id, 5, snapshots);
    assert.equal(recovery.changes[1]!.edits[0]!.text, 'ABCDE def GHI');
    revisions['b.ts'] = 'r2';
    await assert.rejects(service.recover('P','',proposal.id, 5, snapshots));
    revisions['b.ts'] = 'r1';
    await assert.rejects(service.recover('P','',proposal.id, 5, [snapshots[0]!, { ...snapshots[1]!, text: 'new dirty draft' }]));
    const history = JSON.stringify(await service.history('P',''));
    await assert.rejects(service.generate('P','', { ...input, instruction: 'fail' }));
    assert.equal(JSON.stringify(await service.history('P','')), history);
    stopping = true;
    const pending = service.generate('P','', input);
    const rejectedStop = assert.rejects(pending);
    await started.promise; assert.equal(service.stop('P',''), true); continueRun.resolve(); await rejectedStop;
    assert.equal(JSON.stringify(await service.history('P','')), history);
    await service.close();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('proposal persistence refuses symlink parents/files, oversized data and malformed shapes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proposal-security-'));
  try {
    const ws = new Workspace(root); await ws.init();
    const project = ws.projectDir('P'); const directory = path.join(project, '.ai');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'editor-proposals.json');
    const service = new EditorProposalService({ providers: {}, editor: { read: async () => { throw new Error('must not read source'); } }, ws, settings: new SettingsStore(ws, DEFAULT_CONFIG), assertExecutable: async () => {}, isBusy: () => false, concurrentRuns: 1, runSeconds: 10 });
    for (const value of [{}, [null], [{ id: 'malformed', edits: [] }]]) {
      await fs.writeFile(file, JSON.stringify(value));
      await assert.rejects(service.history('P', ''));
    }
    const handle = await fs.open(file, 'w'); await handle.truncate(12 * 1024 * 1024 + 1); await handle.close();
    await assert.rejects(service.history('P', ''));
    await fs.rm(file);
    const outside = path.join(root, 'outside.json'); await fs.writeFile(outside, '[]');
    await fs.symlink(outside, file); await assert.rejects(service.history('P', '')); await fs.rm(file);
    await fs.rmdir(directory);
    const outsideDirectory = path.join(root, 'outside'); await fs.mkdir(outsideDirectory);
    await fs.writeFile(path.join(outsideDirectory, 'editor-proposals.json'), '[]');
    await fs.symlink(outsideDirectory, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(service.history('P', ''));
    assert.equal(await fs.readFile(path.join(outsideDirectory, 'editor-proposals.json'), 'utf8'), '[]');
    await service.close();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('persisted single-file proposals recover into the multifile schema without losing decisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proposal-migration-'));
  try {
    const ws = new Workspace(root); await ws.init(); await fs.mkdir(path.join(ws.projectDir('P'), '.ai'), { recursive: true });
    await fs.writeFile(path.join(ws.projectDir('P'), '.ai', 'editor-proposals.json'), JSON.stringify([{ id: '12345678-1234-1234-1234-123456789abc', project: 'P', task: '', version: 2, ai: 'codex', instruction: 'uppercase', createdAt: new Date().toISOString(), path: 'a.ts', revision: 'r1', base: 'abc', local: 'abc', current: 'Abc', edits: [{ id: '0', from: 0, to: 1, text: 'A', state: 'accepted' }] }]));
    const service = new EditorProposalService({ providers: {}, editor: { read: async () => { throw new Error('history cannot read source'); } }, ws, settings: new SettingsStore(ws, DEFAULT_CONFIG), assertExecutable: async () => {}, isBusy: () => false, concurrentRuns: 1, runSeconds: 10 });
    const [proposal] = await service.history('P', '');
    assert.equal(proposal!.files[0]!.current, 'Abc'); assert.equal(proposal!.files[0]!.edits[0]!.state, 'accepted');
    assert.equal('path' in proposal!, false); await service.close();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('proposal history is empty for a project without an .ai folder and not found for an unknown project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proposal-missing-'));
  try {
    const ws = new Workspace(root); await ws.init(); await fs.mkdir(ws.projectDir('P'), { recursive: true });
    const service = new EditorProposalService({ providers: {}, editor: { read: async () => { throw new Error('unused'); } }, ws, settings: new SettingsStore(ws, DEFAULT_CONFIG), assertExecutable: async () => {}, isBusy: () => false, concurrentRuns: 1, runSeconds: 30 });
    assert.deepEqual(await service.history('P', ''), []);
    await assert.rejects(service.history('Missing', ''), { status: 404, detail: 'project_missing' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
