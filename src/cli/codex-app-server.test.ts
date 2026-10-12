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
// Mirrors codex-cli 0.162.1: review/start returns the root turn; the work runs in a child turn whose rootTurnId points back.
const commandFixture = `import {createInterface} from 'node:readline';
const send = x => console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start'||m.method==='thread/resume') { if((m.params.serviceTier??'')!==process.env.FIXTURE_TIER)process.exit(3); send({id:m.id,result:{thread:{id:'thread'}}}); }
 else if(m.method==='turn/start') process.exit(6);
 else if(m.method==='skills/list') send({id:m.id,result:{data:[{cwd:m.params.cwds[0],errors:[],skills:[
  {name:'lint',description:'Lint the change',path:'/skills/lint/SKILL.md',enabled:true},
  {name:'paused',description:'Disabled skill',path:'/skills/paused/SKILL.md',enabled:false},
  {name:'review',description:'Shadowed by the built-in',path:'/skills/review/SKILL.md',enabled:true},
  {name:'logout',description:'Never offered',path:'/skills/logout/SKILL.md',enabled:true}]}]}});
 else if(m.method==='thread/compact/start') {
  if(m.params.threadId!=='thread')process.exit(5);
  send({id:m.id,result:{}});
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'compact',rootTurnId:'compact'}}});
  send({method:'item/completed',params:{threadId:'thread',turnId:'compact',item:{type:'contextCompaction',id:'c'}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'compact',status:'completed',error:null}}});
 } else if(m.method==='review/start') {
  const target=JSON.stringify(m.params.target);
  if(m.params.delivery!=='inline'||target!==process.env.FIXTURE_TARGET)process.exit(4);
  send({id:m.id,result:{turn:{id:'root'},reviewThreadId:'thread'}});
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'child',rootTurnId:'root'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'root',itemId:'raw',delta:'{"findings":[]}'}});
  send({method:'item/completed',params:{threadId:'thread',turnId:'root',item:{type:'exitedReviewMode',id:'r',review:'No issues.'}}});
  send({method:'item/completed',params:{threadId:'thread',turnId:'root',item:{type:'agentMessage',id:'m',text:'No issues.'}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'root',status:'completed',error:null}}});
 }
}).on('close',()=>process.exit(0));`;
test('app-server runs /compact and /review as thread operations and carries the /fast tier', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-commands-'));
 try {
  const file = path.join(dir, 'fixture.ts'); await fs.writeFile(file, commandFixture);
  for (const [slashCommand, resumeId, target, ok, answer, fast, tier] of [
   ['/compact', 'thread', '', true, '', undefined, ''],
   ['/compact', undefined, '', false, '', undefined, ''],
   ['/review', undefined, '{"type":"uncommittedChanges"}', true, 'No issues.', true, 'priority'],
   ['/review  focus on auth ', 'thread', '{"type":"custom","instructions":"focus on auth"}', true, 'No issues.', false, 'default'],
   ['/fast', 'thread', '', false, '', true, 'priority'],
  ] as const) {
   const provider = new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, command: process.execPath, appServerArgs: [file] }, [], { PATH: process.env.PATH, FIXTURE_TARGET: target, FIXTURE_TIER: tier });
   const events: CliEvent[] = [];
   const run = () => provider.send({ prompt: 'preamble', cwd: dir, slashCommand, ...(resumeId ? { resumeId } : {}), ...(fast === undefined ? {} : { fast }) }, e => events.push(e));
   // /fast is resolved by the core into a task setting; reaching the transport is a contract violation.
   if (slashCommand === '/fast') { assert.throws(run); continue; }
   const result = await run().done;
   assert.equal(result.ok, ok, slashCommand);
   if (ok) assert.deepEqual(events.find(e => e.type === 'result'), { type: 'result', text: answer });
   else assert.ok(events.some(e => e.type === 'error'));
  }
  const provider = new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, command: process.execPath, appServerArgs: [file] }, [], { PATH: process.env.PATH, CODEX_HOME: dir });
  assert.deepEqual((await provider.commands(dir)).map(c => c.name), ['apps', 'archive', 'btw', 'clear', 'compact', 'debug-config', 'delete', 'experimental', 'fast', 'fork', 'goal', 'hooks', 'lint', 'mcp', 'new', 'permissions', 'plugins', 'rename', 'resume', 'review', 'side', 'skills', 'status', 'usage']);
  assert.deepEqual(await provider.resolveCommand('/review focus', dir), { text: '/review focus', native: true });
  for (const [text, fast] of [['/fast', 'toggle'], [' /fast ON ', 'on'], ['/fast off', 'off'], ['/fast status', 'status']] as const) {
    assert.equal((await provider.resolveCommand(text, dir)).fast, fast);
  }
  // Reports and goal/name changes leave the task's session alone; switching threads and goal-driven turns do not.
  for (const [text, standalone] of [['/goal', true], ['/goal clear', true], ['/goal ship the release', false], ['/resume', true], ['/resume 01a1-22ef', false], ['/rename Release work', true], ['/side why?', true], ['/new', false], ['/usage', true], ['/lint src only', false]] as const) {
    assert.equal((await provider.resolveCommand(text, dir)).standalone === true, standalone, text);
  }
  for (const text of ['/compact now', '/fast maybe', '/model', '/login', '/logout', '/vim', '/paused', '/new chat', '/rename', '/side', '/resume ../x', '/rename a\nb']) await assert.rejects(provider.resolveCommand(text, dir), { detail: 'slash_unsupported' }, text);
  const exec = new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, mode: 'exec' }, [], { PATH: process.env.PATH, CODEX_HOME: dir });
  assert.deepEqual(await exec.commands(dir), []);
  await assert.rejects(exec.resolveCommand('/compact', dir), { detail: 'slash_unsupported' });
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
// Shapes follow codex-cli 0.162.1 as probed live: thread/goal/set answers first and the goal's own turn streams
// right after it (here before the run has even processed the answer), ephemeral forks need excludeTurns.
const controlFixture = `import {createInterface} from 'node:readline';
const send = x => console.log(JSON.stringify(x));
const done = (threadId, id, text) => { send({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:'m'+id,delta:text}}); send({method:'turn/completed',params:{threadId,turn:{id,status:'completed',error:null}}}); };
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); const p=m.params??{};
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'fresh'}}});
 else if(m.method==='thread/resume') { if(p.threadId!=='thread'&&p.threadId!=='other')process.exit(3); send({id:m.id,result:{thread:{id:p.threadId}}}); }
 else if(m.method==='thread/fork') { if(p.threadId!=='thread'||(p.ephemeral&&!p.excludeTurns))process.exit(4); send({id:m.id,result:{thread:{id:p.ephemeral?'side':'forked'}}}); }
 else if(m.method==='thread/name/set') { if(p.threadId!=='thread')process.exit(5); send({id:m.id,result:{}}); send({method:'thread/name/updated',params:{threadId:'thread',threadName:p.name}}); }
 else if(m.method==='thread/archive'||m.method==='thread/delete') { if(p.threadId!=='thread')process.exit(6); send({id:m.id,result:{}}); }
 else if(m.method==='thread/goal/get') send({id:m.id,result:{goal:{threadId:'thread',objective:'Ship it',status:'active',tokenBudget:null,tokensUsed:12,timeUsedSeconds:3}}});
 else if(m.method==='thread/goal/set') { if(p.origin!=='user')process.exit(7); send({id:m.id,result:{goal:{threadId:'thread',objective:p.objective,status:'active',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0}}});
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'auto',rootTurnId:'auto'}}}); done('thread','auto','working on '+p.objective); }
 else if(m.method==='skills/list') send({id:m.id,result:{data:[{cwd:p.cwds[0],errors:[],skills:[{name:'lint',description:'Lint',path:'/skills/lint/SKILL.md',enabled:true}]}]}});
 else if(m.method==='account/rateLimits/read') send({id:m.id,result:{rateLimits:{limitId:'codex',limitName:null,primary:{usedPercent:40,windowDurationMins:300,resetsAt:0},secondary:null,credits:null},rateLimitsByLimitId:null}});
 else if(m.method==='turn/start') { const id='turn-'+p.threadId; send({id:m.id,result:{turn:{id}}}); done(p.threadId,id,JSON.stringify(p.input)); }
 else if(m.id!==undefined) process.exit(9);
}).on('close',()=>process.exit(0));`;
test('app-server carries the TUI commands it has a protocol for, keeping or replacing the session as the TUI does', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-controls-'));
 try {
  const file = path.join(dir, 'fixture.ts'); await fs.writeFile(file, controlFixture);
  const provider = new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, command: process.execPath, appServerArgs: [file] }, [], { PATH: process.env.PATH });
  const run = async (slashCommand: string, resumeId?: string) => {
   const events: CliEvent[] = [];
   const outcome = await provider.send({ prompt: 'preamble', cwd: dir, slashCommand, ...(resumeId ? { resumeId } : {}) }, e => events.push(e)).done;
   // null marks the end of the task's session: the next instruction starts a new thread.
   return { ok: outcome.ok, sessions: events.flatMap(e => e.type === 'session' ? [e.id] : e.type === 'sessionEnd' ? [null] : []), result: events.flatMap(e => e.type === 'result' ? [e.text] : []).join('') };
  };
  assert.deepEqual(await run('/rename Release work', 'thread'), { ok: true, sessions: [], result: 'name: Release work' });
  assert.deepEqual(await run('/goal', 'thread'), { ok: true, sessions: [], result: 'goal: Ship it\nstatus: active\ntokens used: 12\ntime used: 3 s' });
  assert.deepEqual(await run('/goal Ship it', 'thread'), { ok: true, sessions: ['thread'], result: 'working on Ship it' });
  // A thread/start id is not resumable until its first turn, so /new must not hand one out as the session.
  assert.deepEqual(await run('/new', 'thread'), { ok: true, sessions: [null], result: 'thread: (a new one starts with the next instruction)' });
  assert.deepEqual(await run('/archive', 'thread'), { ok: true, sessions: [null], result: 'archived: thread\nthread: (a new one starts with the next instruction)' });
  assert.deepEqual(await run('/delete', 'thread'), { ok: true, sessions: [null], result: 'deleted: thread\nthread: (a new one starts with the next instruction)' });
  assert.deepEqual(await run('/fork', 'thread'), { ok: true, sessions: ['forked'], result: 'forked: thread\nthread: forked' });
  assert.deepEqual(await run('/resume other', 'thread'), { ok: true, sessions: ['other'], result: 'thread: other' });
  assert.match((await run('/usage')).result, /^- codex primary: 40% used, 300 min window, resets 1970-01-01T00:00:00.000Z$/u);
  // The side question runs on the ephemeral fork with the preamble; the task's thread is never announced.
  assert.deepEqual(await run('/side why so slow?', 'thread'), { ok: true, sessions: [], result: JSON.stringify([{ type: 'text', text: 'preamble\nwhy so slow?', text_elements: [] }]) });
  assert.deepEqual(await run('/lint src only', 'thread'), { ok: true, sessions: ['thread'], result: JSON.stringify([{ type: 'text', text: 'preamble\n$lint src only', text_elements: [] }, { type: 'skill', name: 'lint', path: '/skills/lint/SKILL.md' }]) });
  // Thread commands need the task's thread; an unknown name is no skill and never becomes a plain prompt.
  for (const command of ['/rename x', '/goal', '/fork', '/side x', '/delete']) assert.equal((await run(command)).ok, false, command);
  assert.deepEqual(await run('/unknown', 'thread'), { ok: false, sessions: ['thread'], result: '' });
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
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
test('a file-change approval shows the files and diff codex announced for that item, without protocol bookkeeping', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-file-change-'));
 // Shapes follow the generated 0.162.1 ItemStartedNotification / FileUpdateChange / FileChangeRequestApprovalParams.
 const source = `import {createInterface} from 'node:readline';
const send = x => console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{userAgent:'fixture',platformFamily:'unix',platformOs:'linux'}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
 else if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
  send({method:'item/started',params:{threadId:'thread',turnId:'turn',startedAtMs:1,item:{type:'fileChange',id:'patch',status:'inProgress',changes:[{path:'/repo/a.txt',kind:{type:'update',move_path:null},diff:'@@ -1 +1 @@\\\\n-old\\\\n+new'},{path:'/repo/run.sh',kind:{type:'add'},diff:'+curl x | sh'}]}}});
  send({id:70,method:'item/fileChange/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'patch',startedAtMs:1,reason:'apply the edit'}});
 } else if(m.id===70&&!m.method) send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',error:null}}});
}).on('close',()=>process.exit(0));`;
 try {
  const file = path.join(dir, 'fixture.ts'); await fs.writeFile(file, source);
  const provider = new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, command: process.execPath, appServerArgs: [file], fullAccess: false }, []);
  const events: CliEvent[] = [];
  await provider.send({ prompt: 'instruction', cwd: dir }, event => { events.push(event); if (event.type === 'permission') event.respond(false); }).done;
  const permission = events.find(event => event.type === 'permission');
  assert.ok(permission?.type === 'permission');
  assert.deepEqual(Object.keys(permission.input).sort(), ['diff', 'files', 'reason']);
  assert.equal(permission.input['files'], 'update /repo/a.txt\nadd /repo/run.sh');
  assert.match(String(permission.input['diff']), /\+curl x \| sh/);
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
