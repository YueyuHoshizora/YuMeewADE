import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditorProposalService, parseProposalEdits } from './editor-proposals.ts';
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
test('real exec fixture generates concrete proposals: isolation, disk revision, decisions, dirty conflict and undo', { skip: process.platform === 'win32' }, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'proposal-fixture-'));
  try {
    const ws=new Workspace(root);await ws.init();await fs.mkdir(path.join(ws.projectDir('P'),'.ai'),{recursive:true});
    const cli=path.join(root,'codex-fixture');
    await fs.writeFile(cli,`#!${process.execPath}\nlet prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{\nif(!process.argv.includes('--sandbox')||!process.argv.includes('read-only')||!process.argv.includes('--ignore-user-config')||!process.argv.includes('--ignore-rules')||!process.argv.includes('--ephemeral')||process.argv.includes('resume')||!process.cwd().includes('yumeewade-proposal-'))process.exit(8);\nconst data=JSON.parse(prompt.slice(prompt.indexOf('\\n')+1));if(data.buffer!=='abc def ghi'||!['uppercase first and last','adjacent ranges','line endings'].includes(data.instruction))process.exit(7);\nconst edits=data.instruction==='adjacent ranges'?[{from:0,to:3,text:'ABCDE'},{from:3,to:4,text:'!!'}]:[{from:0,to:3,text:data.instruction==='line endings'?'A\\r\\nB\\r':'ABCDE'},{from:8,to:11,text:'GHI'}];\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'fresh'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({edits})}}));console.log(JSON.stringify({type:'turn.completed'}));});\n`,{mode:0o700});
    const provider=new CodexCliProvider({...DEFAULT_CONFIG.cli.codex,command:cli},[]);
    let revision='r1';
    const document:EditorDocument={path:'a.ts',text:'abc def ghi',revision,language:'typescript',size:11,binary:false,truncated:false,readonly:false,languageAvailable:false};
    const service=new EditorProposalService({providers:{codex:provider},editor:{read:async()=>({...document,revision})},ws,settings:new SettingsStore(ws,DEFAULT_CONFIG),assertExecutable:async()=>{},isBusy:()=>false,concurrentRuns:2,runSeconds:30});
    const input={path:'a.ts',revision:'r1',text:'abc def ghi',selection:{from:0,to:11},instruction:'uppercase first and last',ai:'codex'};
    await assert.rejects(service.generate('P','',{...input,revision:'stale'}));
    const proposal=await service.generate('P','',input);assert.equal(proposal.edits.length,2);assert.equal(document.text,'abc def ghi');
    await assert.rejects(service.decide('P','',proposal.id,1,'0',true,'changed dirty buffer'));
    const first=await service.decide('P','',proposal.id,1,'0',true,input.text);
    assert.deepEqual(first.edits,[{from:0,to:3,text:'ABCDE'}]);assert.equal(first.proposal.current,'ABCDE def ghi');
    // Undo restores the original draft and makes the saved proposal state stale.
    await assert.rejects(service.decide('P','',proposal.id,2,'1',true,input.text));
    const reject=await service.decide('P','',proposal.id,2,'1',false,first.proposal.current);assert.deepEqual(reject.edits,[]);assert.equal(reject.proposal.edits[1]!.state,'rejected');
    const second=await service.generate('P','',input);const last=await service.decide('P','',second.id,1,'0',true,input.text);const accepted=await service.decide('P','',second.id,2,'1',true,last.proposal.current);
    assert.deepEqual(accepted.edits,[{from:10,to:13,text:'GHI'}]);assert.equal(accepted.proposal.current,'ABCDE def GHI');
    const adjacent = await service.generate('P', '', { ...input, instruction: 'adjacent ranges' });
    const adjacentFirst = await service.decide('P', '', adjacent.id, 1, '0', true, input.text);
    const adjacentLast = await service.decide('P', '', adjacent.id, 2, '1', true, adjacentFirst.proposal.current);
    assert.deepEqual(adjacentLast.edits, [{ from: 5, to: 6, text: '!!' }]);
    assert.equal(adjacentLast.proposal.current, 'ABCDE!!def ghi');
    const newline = await service.generate('P', '', { ...input, instruction: 'line endings' });
    const newlineFirst = await service.decide('P', '', newline.id, 1, '0', true, input.text);
    assert.equal(newlineFirst.proposal.current, 'A\nB\n def ghi');
    const newlineLast = await service.decide('P', '', newline.id, 2, '1', true, newlineFirst.proposal.current);
    assert.deepEqual(newlineLast.edits, [{ from: 9, to: 12, text: 'GHI' }]);
    assert.equal(newlineLast.proposal.current, 'A\nB\n def GHI');
    revision='r2';await assert.rejects(service.decide('P','',proposal.id,3,'1',false,reject.proposal.current));
    const persisted = await service.history('P', '');
    assert.equal(persisted.find(value => value.id === proposal.id)?.edits[1]?.state, 'rejected');
    assert.equal(persisted.find(value => value.id === adjacent.id)?.current, 'ABCDE!!def ghi');
    await service.close();
  } finally {await fs.rm(root,{recursive:true,force:true});}
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
