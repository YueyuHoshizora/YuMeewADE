import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexCliProvider } from './codex.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import type { CliEvent, CliRun } from './provider.ts';
import { TurnPermissions } from '../chat/permissions.ts';
// Fixture follows the generated 0.162.1 request/notification/approval schemas.
const fixture = `import {createInterface} from 'node:readline';
const send = x => console.log(JSON.stringify(x));
let turn = false;
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') { if(m.params.clientInfo.name!=='yumeewade') process.exit(9); send({id:m.id,result:{userAgent:'fixture',platformFamily:'unix',platformOs:'linux'}}); }
 else if(m.method==='thread/start'||m.method==='thread/resume') {
  if(m.params.approvalPolicy!=='on-request'||m.params.sandbox!=='workspace-write'||m.params.approvalsReviewer!=='user') process.exit(8);
  if(m.method==='thread/resume'&&m.params.threadId!=='thread')process.exit(7);
  send({id:m.id,result:{thread:{id:'thread'}}});
 } else if(m.method==='turn/start') {
  if(m.params.input[0].text!=='instruction'||m.params.input[0].text_elements.length||m.params.effort!=='high'||m.params.sandboxPolicy.networkAccess!==false)process.exit(6);
  turn=true;send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
  send({id:70,method:'item/commandExecution/requestApproval',params:{kind:'command',threadId:'thread',turnId:'turn',itemId:'command',startedAtMs:1,environmentId:null,command:'echo test',cwd:process.cwd()}});
 } else if(m.id===70&&!m.method) {
  if(!['accept','decline'].includes(m.result.decision))process.exit(5);
  send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'message',delta:m.result.decision}});
  if(process.env.FIXTURE_HOLD!=='1')send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',error:null,items:[],itemsView:'full',rootTurnId:null,startedAt:1,completedAt:2,durationMs:1000}}});
 } else if(m.method==='turn/interrupt') {
  if(!turn||m.params.threadId!=='thread'||m.params.turnId!=='turn')process.exit(4);
  send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'interrupted',error:null}}});
 }
}).on('close',()=>process.exit(Number(process.env.FIXTURE_EXIT||0)));`;
for (const scenario of ['accept', 'decline', 'resume', 'interrupt', 'nonzero'] as const) test(`app-server ${scenario}: real stdio lifecycle`, async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rpc-'));
 try {
  const file=path.join(dir,'fixture.ts'); await fs.writeFile(file,fixture);
  const provider=new CodexCliProvider({...DEFAULT_CONFIG.cli.codex,command:process.execPath,appServerArgs:[file],fullAccess:false},[],{PATH:process.env.PATH,FIXTURE_HOLD:scenario==='interrupt'?'1':'0',FIXTURE_EXIT:scenario==='nonzero'?'3':'0'});
  const events:CliEvent[]=[];
  const delta = Promise.withResolvers<void>();
  const run=provider.send({prompt:'instruction',cwd:dir,effort:'high',...(scenario==='resume'?{resumeId:'thread'}:{})},event=>{events.push(event);if(event.type==='permission')event.respond(scenario!=='decline');if(event.type==='delta')delta.resolve();});
  if(scenario==='interrupt') { await delta.promise;run.stop(); }
  const result=await run.done;assert.equal(result.ok,scenario!=='interrupt'&&scenario!=='nonzero');assert.equal(result.stopped,scenario==='interrupt');
  assert.equal(events.filter(e=>e.type==='session').length,1);
  assert.ok(events.some(e=>e.type==='permission'&&e.input['command']==='echo test'));
  assert.ok(events.some(e=>e.type==='delta'&&e.text===(scenario==='decline'?'decline':'accept')));
  if(scenario==='nonzero')assert.ok(events.some(e=>e.type==='error'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('app-server disconnect and invalid JSON fail closed',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-disconnect-'));
 try {for(const source of ['process.exit(0)',"console.log('not-json');process.stdin.resume()"]){
  const file=path.join(dir,'fixture.ts');await fs.writeFile(file,source);
  const provider=new CodexCliProvider({...DEFAULT_CONFIG.cli.codex,command:process.execPath,appServerArgs:[file]},[]);
  const events:CliEvent[]=[];const result=await provider.send({prompt:'x',cwd:dir},e=>events.push(e)).done;
  assert.equal(result.ok,false);assert.ok(events.some(e=>e.type==='error'));
 }}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('native approval remains answerable throughout the configured core approval window', async context => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-approval-window-'));
 const permissions = new TurnPermissions(300, () => {});
 let run: CliRun | undefined;
 try {
  const file = path.join(dir, 'fixture.ts'); await fs.writeFile(file, fixture);
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const provider = new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, command: process.execPath, appServerArgs: [file], fullAccess: false }, []);
  const pending = Promise.withResolvers<void>(); const events: CliEvent[] = [];
  run = provider.send({ prompt: 'instruction', cwd: dir, effort: 'high' }, event => {
   events.push(event);
   if (event.type === 'permission') { permissions.request(event); pending.resolve(); }
  });
  await pending.promise;
  context.mock.timers.tick(120_001);
  const card = permissions.cards()[0]!;
  assert.equal(permissions.answer(card.id, true), true);
  assert.equal((await run.done).ok, true);
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['accept']);
 } finally {
  permissions.close(); run?.stop(); context.mock.timers.reset();
  await run?.done; await fs.rm(dir, { recursive: true, force: true });
 }
});
