import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockCliProvider, type MockOptions } from '../cli/mock.ts';
import type { CliEvent, RunOutcome, SendOptions } from '../cli/provider.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { CompletionStore } from '../ledger/completion.ts';
import { SettingsStore } from '../ledger/settings.ts';
import { OpLog } from '../ledger/oplog.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { loadRoles } from '../roles/roles.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import type { Workspace } from '../ledger/workspace.ts';
import { WorktreeService } from '../git/worktree.ts';
import type { ChatEvent, VerifyResult } from '../shared/types.ts';
import { HISTORY_PAGE } from '../shared/types.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerChatRoutes } from '../http/routes/chat.ts';
import type { Ctx, Handler, Router } from '../http/router.ts';
import type { App } from '../server/app.ts';
import { ChatRunner } from './runner.ts';
import type { RunnerDeps } from './runner.ts';
import { ChatStore } from './store.ts';
import { WorkflowService } from './workflows.ts';
import { UsageHistory } from '../ai/usage-history.ts';
import { AppError } from '../shared/errors.ts';
import { saveContext, readContextManifest } from './context.ts';
import { readDraft, updateDraft } from './drafts.ts';
async function setup(ws: Workspace, options: MockOptions = {}, runSeconds = 600, overrides: Partial<RunnerDeps> = {}) {
  const projects = new ProjectLedger(ws); await projects.create({ name: 'P' });
  const tasks = new TaskLedger(ws); const task = await tasks.create('P', { title: 'T', workspace: 'direct' });
  const settings = new SettingsStore(ws, DEFAULT_CONFIG); await settings.update({ initial: { ai: 'codex', model: 'm', effort: 'high' } });
  const store = new ChatStore(ws); const calls: SendOptions[] = []; const events: ChatEvent[] = [];
  const mock = new MockCliProvider({ chunkMs: 1, ...options, text: opts => { calls.push(opts); return typeof options.text === 'function' ? options.text(opts) : options.text ?? 'ok'; } });
  const completion = new CompletionStore(ws);
  const restored: string[] = []; let checkpointCount = 0;
  const ranges: string[][] = [];
  const forks: string[] = [];
  const usageAccounts: string[] = [];
  const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: DEFAULT_CONFIG.limits.diffBytes });
  const runner = new ChatRunner({ ws, store, projects, tasks, settings, completion, oplog: new OpLog(ws), roles: () => loadRoles(ws.rolesFile), providers: { mock, claude: mock, codex: mock }, limits: { concurrentRuns: 2, queueLength: 3, handoffChars: 60000, imagesPerSend: 10, runSeconds }, worktree: { bodyPath: async () => ws.projectDir('P'), prepare: async () => ws.projectDir('P'), checkpoint: async () => String(++checkpointCount).padStart(40, '0'), restore: async (_p: string, _t: string, sha: string) => { restored.push(sha); }, finishTurn: async (_p: string, _t: string, start: string) => start.endsWith('1') ? { after: 'f'.repeat(40), changes: { files: 2, added: 3, removed: 1 } } : { after: 'e'.repeat(40) }, rangeDiff: async (_p: string, _t: string, from: string, to: string) => { ranges.push([from, to]); return { diff: 'd', truncated: false }; }, prepareFrom: async (_p: string, _t: string, sha: string) => { forks.push(sha); return ws.projectDir('P'); } } as unknown as WorktreeService, publish: (_p, _t, ev) => events.push(ev), onChanged: () => {}, onUsage: (_ai, _event, account) => { usageAccounts.push(account); }, ...overrides });
  const send = (text: string, extra: Partial<Parameters<ChatRunner['send']>[0]> = {}) => runner.send({ project: 'P', task: task.id, text, ...extra });
  return { runner, store, settings, projects, tasks, task, send, calls, events, usageAccounts, completion, restored, ranges, forks, mock, worktree };
}
test('Mock CLI receives numbered file references on first send, resume and provider handoff while stored text stays original', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  await fs.writeFile(path.join(ws.projectDir('P'), 'sample.ts'), 'first\nreference payload\nthird');
  for (const ai of ['codex', 'codex', 'claude']) {
    const text = ai === 'claude' ? 'Continue' : 'Read @sample.ts#L2 @missing';
    await s.send(text, { ai });
    await s.runner.whenIdle();
    assert.match(s.calls.at(-1)!.prompt, /# 引用檔案/u);
    assert.match(s.calls.at(-1)!.prompt, /2: reference payload/u);
    const user = (await s.store.readLog('P', s.task.id)).findLast(r => r.role === 'user');
    assert.ok(user?.role === 'user');
    assert.equal(user.text, text);
    assert.deepEqual(user.mentions?.map(m => m.status) ?? [], ai === 'claude' ? [] : ['resolved', 'not-found']);
  }
  assert.ok(s.calls[1]?.resumeId);
  assert.match(s.calls[2]!.prompt, /previous_conversation/u);
}));
test('sent context manifests preserve exact source snapshot after later file changes', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const file = path.join(ws.projectDir('P'), 'sample.ts');
  await fs.writeFile(file, 'first source\nsecond source\n');
  await saveContext(ws, 'P', s.task.id, {
    decisions: 'Keep the public API stable.', decisionBudget: 100,
    sources: [{ path: 'sample.ts', start: 1, end: 2, allocatedChars: 100, enabled: true }],
    revision: 0,
  });
  await s.send('make the requested change'); await s.runner.whenIdle();
  const rows = await s.store.readLog('P', s.task.id);
  const turn = rows.find(row => row.role === 'user');
  assert.ok(turn?.role === 'user');
  await fs.writeFile(file, 'replacement after send\n');
  const manifest = await readContextManifest(ws, 'P', s.task.id, turn.request);
  assert.ok(manifest);
  assert.match(manifest.context.text, /1: first source\n2: second source/u);
  assert.doesNotMatch(manifest.context.text, /replacement after send/u);
  assert.ok(s.calls[0]?.prompt.includes(manifest.context.text));
  assert.equal(manifest.context.allocations.find(row => row.id === 'source:0')?.status, 'included');
}));
test('standalone CLI reports preserve resumable conversation state on success and failure', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  await s.send('start conversation');
  await s.runner.whenIdle();
  const before = await s.store.readMeta('P', s.task.id);
  const expected = { sessions: before.sessions, models: before.models, seen: before.seen, accounts: before.accounts };
  let succeeds = true;
  Object.assign(s.mock, {
    resolveCommand: async (text: string) => ({ text, native: true, standalone: true }),
    send: (_opts: SendOptions, onEvent: (ev: CliEvent) => void) => {
      onEvent(succeeds ? { type: 'result', text: 'Available quota: 81%' } : { type: 'error', reason: 'report unavailable' });
      return { stop: () => undefined, done: Promise.resolve({ ok: succeeds, stopped: false }) };
    },
  });
  for (const success of [true, false]) {
    succeeds = success;
    await s.send('/usage');
    await s.runner.whenIdle();
    const after = await s.store.readMeta('P', s.task.id);
    assert.deepEqual({ sessions: after.sessions, models: after.models, seen: after.seen, accounts: after.accounts }, expected);
    const reply = (await s.store.readLog('P', s.task.id)).at(-1);
    assert.ok(reply?.role === 'assistant');
    if (success) assert.equal(reply.text, 'Available quota: 81%');
    else assert.equal(reply.error, 'cli_failed');
  }
}));
test('超過單輪時間上限就停止並標記 timeout，不自動接續隊列', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5 }, 0.05);
  await s.send('stuck [slow]');
  await s.send('after', { mode: 'queue' });
  await s.runner.whenIdle();
  const reply = (await s.store.readLog('P', s.task.id)).find(r => r.role === 'assistant');
  assert.ok(reply?.role === 'assistant'); assert.equal(reply.error, 'timeout'); assert.equal(reply.stopped, true);
  assert.equal(s.runner.isRunning('P', s.task.id), false);
  assert.equal((await s.store.readQueue('P', s.task.id)).length, 1, 'the queue waits for a human after a timeout');
  assert.equal((await s.store.readLog('P', s.task.id)).some(r => r.role === 'user' && r.text === 'after'), false);
}));
test('fork 從指定指示的檢查點長出分支作業，帶走之前的對話但不帶附件，並拒絕執行中', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5 });
  await s.send('first'); await s.runner.whenIdle(); await s.send('second'); await s.runner.whenIdle();
  const rows = await s.store.readLog('P', s.task.id);
  const users = rows.filter(r => r.role === 'user');
  const second = users[1];
  assert.ok(second?.role === 'user' && second.checkpoint);
  const forked = await s.runner.fork('P', s.task.id, second.request);
  assert.equal(forked.kind, 'derived'); assert.equal(forked.derivedFrom, s.task.id); assert.equal(forked.title, 'T（分支）'); assert.equal(forked.workspace, 'isolated');
  assert.deepEqual(s.forks, [second.checkpoint]);
  const copied = await s.store.readLog('P', forked.id);
  assert.deepEqual(copied.slice(0, -1).map(r => [r.role, r.text]), rows.slice(0, rows.findIndex(r => r === second || (r.role === 'user' && r.request === second.request))).map(r => [r.role, r.text]));
  assert.equal(copied.at(-1)?.role, 'event'); assert.match(copied.at(-1)?.text ?? '', /second/);
  assert.equal(copied.some(r => r.role === 'user' && r.text === 'second'), false);
  assert.equal((await s.tasks.get('P', s.task.id)).kind, 'main', 'the source task is untouched');
  await assert.rejects(s.runner.fork('P', s.task.id, 'missing'), (e: unknown) => e instanceof Error && 'detail' in e && e.detail === 'checkpoint_missing');
  await s.send('slow [slow]');
  await assert.rejects(s.runner.fork('P', s.task.id, second.request), (e: unknown) => e instanceof Error && 'detail' in e && e.detail === 'fork_while_running');
  await s.runner.stop('P', s.task.id); await s.runner.whenIdle();
}));
test('回合結束的檢查點與變更量寫進回覆，turnDiff 取兩端檢查點的差異', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  await s.send('first'); await s.runner.whenIdle(); await s.send('second'); await s.runner.whenIdle();
  const rows = await s.store.readLog('P', s.task.id);
  const replies = rows.filter(r => r.role === 'assistant');
  assert.ok(replies[0]?.role === 'assistant'); assert.equal(replies[0].after, 'f'.repeat(40)); assert.deepEqual(replies[0].changes, { files: 2, added: 3, removed: 1 });
  assert.ok(replies[1]?.role === 'assistant'); assert.equal(replies[1].after, 'e'.repeat(40)); assert.equal(replies[1].changes, undefined);
  const user = rows.find(r => r.role === 'user');
  assert.ok(user?.role === 'user');
  assert.deepEqual(await s.runner.turnDiff('P', s.task.id, user.request), { diff: 'd', truncated: false });
  assert.deepEqual(s.ranges, [[user.checkpoint, 'f'.repeat(40)]]);
  await assert.rejects(s.runner.turnDiff('P', s.task.id, 'missing'), (e: unknown) => e instanceof Error && 'detail' in e && e.detail === 'checkpoint_missing');
}));
test('rollback 還原到指定指示的檢查點、清除 session，並在交接包告知 AI', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5 });
  await s.send('first'); await s.runner.whenIdle(); await s.send('second'); await s.runner.whenIdle();
  const users = (await s.store.readLog('P', s.task.id)).filter(r => r.role === 'user');
  const first = users[0]; assert.ok(first?.role === 'user'); assert.match(first.checkpoint ?? '', /^0+1$/);
  await s.runner.rollback('P', s.task.id, first.request);
  assert.deepEqual(s.restored, [first.checkpoint]);
  const meta = await s.store.readMeta('P', s.task.id); assert.deepEqual(meta.sessions, {}); assert.deepEqual(meta.seen, {});
  const note = (await s.store.readLog('P', s.task.id)).at(-1); assert.ok(note?.role === 'event'); assert.equal(note.rollback, true); assert.match(note.text, /first/);
  await s.send('third'); await s.runner.whenIdle();
  assert.equal(s.calls.at(-1)?.resumeId, undefined);
  await assert.rejects(s.runner.rollback('P', s.task.id, 'nope'), (e: unknown) => e instanceof Error && 'detail' in e && e.detail === 'checkpoint_missing');
  await s.send('slow [slow]'); await assert.rejects(s.runner.rollback('P', s.task.id, first.request), (e: unknown) => e instanceof Error && 'detail' in e && e.detail === 'rollback_while_running');
  await s.runner.stop('P', s.task.id); await s.runner.whenIdle();
}));
test('roleless defaults, tool rows, asks, answer clearing, unread', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { text: opts => opts.prompt.includes('answer now') ? 'thanks' : 'done\n[[question]]\nWhich?\n1. A\n2. B\n[[/question]]', events: [{ type: 'tool', text: 'Read file.ts' }] });
  await s.send('go'); await s.runner.whenIdle();
  const task = await s.tasks.get('P', s.task.id); assert.equal(task.cli, 'codex'); assert.equal(task.model, 'm'); assert.equal(task.state, '等待回覆'); assert.equal(task.question, 'Which?');
  const rows = await s.store.readLog('P', s.task.id); assert.equal(rows[0]?.role, 'user'); assert.equal(rows[1]?.role, 'event'); assert.equal(rows[2]?.text, 'done');
  assert.equal(s.runner.unread().length, 1); s.runner.markRead('P', s.task.id);
  await s.send('answer now', { answer: true }); await s.runner.whenIdle(); assert.equal((await s.tasks.get('P', s.task.id)).question, '');
  // Every finished turn is unread until the task page reports it was seen; an open page in a background window is not.
  assert.deepEqual(s.runner.unread(), [{ project: 'P', task: s.task.id }]);
  assert.ok(s.calls[1]?.resumeId); assert.ok(s.events.some(e => e.event === 'busy'));
}));
test('mode required; redo/amend stop prior run and keep queue; normal finish drains', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5, stopMs: 2 });
  await s.send('first [slow]'); await assert.rejects(s.send('missing'), /取消重做/u);
  await s.send('later', { mode: 'queue' }); await s.send('replacement', { mode: 'redo' });
  await s.runner.whenIdle();
  let rows = await s.store.readLog('P', s.task.id); assert.ok(rows.some(r => r.role === 'assistant' && r.stopped)); assert.ok(rows.some(r => r.role === 'user' && r.text.includes('人取消了前一個指示'))); assert.equal(rows.at(-2)?.text, 'later'); assert.deepEqual(await s.store.readQueue('P', s.task.id), []);
  const dequeued = rows.find(r => r.role === 'user' && r.text === 'later');
  assert.ok(dequeued?.role === 'user'); assert.equal(dequeued.mode, 'queue');
  await s.send('base [slow]'); await s.send('extra', { mode: 'amend' }); await s.runner.whenIdle();
  rows = await s.store.readLog('P', s.task.id); assert.ok(rows.some(r => r.role === 'user' && r.text.includes('延續已做到的部分')));
}));
test('stop clears queue; unqueue and fromQueue; queued launch error remains', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5 }); await s.send('slow [slow]'); const queued = await s.send('remove', { mode: 'queue' });
  await s.runner.unqueue('P', s.task.id, queued.request); await s.send('discard', { mode: 'queue' }); assert.equal(await s.runner.stop('P', s.task.id), true); await s.runner.whenIdle(); assert.deepEqual(await s.store.readQueue('P', s.task.id), []);
  await s.store.updateQueue('P', s.task.id, () => [{ id: 'saved', text: 'from disk', ai: 'mock', at: 't' }]);
  await s.send('', { fromQueue: 'saved' }); await s.runner.whenIdle(); assert.deepEqual(await s.store.readQueue('P', s.task.id), []);
  const started = (await s.store.readLog('P', s.task.id)).find(r => r.role === 'user' && r.text === 'from disk');
  assert.ok(started?.role === 'user'); assert.equal(started.mode, 'queue');
  await s.send('normal'); await s.store.updateQueue('P', s.task.id, () => [{ id: 'bad', text: 'x', ai: 'missing', at: 't' }]); await s.runner.whenIdle(); assert.equal((await s.store.readQueue('P', s.task.id))[0]?.error, 'bad_request');
}));
test('unqueue with restore returns queued images to the task draft so the instruction can be edited', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5 }); await s.send('slow [slow]');
  const image = '11111111-1111-4111-8111-111111111111.png';
  const kept = await s.send('edit me', { mode: 'queue', images: [image] });
  const dropped = await s.send('drop me', { mode: 'queue', images: ['22222222-2222-4222-8222-222222222222.png'] });
  assert.deepEqual((await s.runner.unqueue('P', s.task.id, kept.request, true)).map(item => item.text), ['drop me']);
  assert.deepEqual((await readDraft(ws, 'P', s.task.id)).images.map(item => item.id), [image]);
  await s.runner.unqueue('P', s.task.id, dropped.request);
  assert.deepEqual((await readDraft(ws, 'P', s.task.id)).images.map(item => item.id), [image], 'a plain removal does not touch the draft');
  await s.runner.stop('P', s.task.id); await s.runner.whenIdle();
}));
test('unqueue with restore refuses instead of dropping images the full draft cannot take', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5 }); await s.send('slow [slow]');
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111.png`;
  const queued = await s.send('two images', { mode: 'queue', images: [id(90), id(91)] });
  await updateDraft(ws, 'P', s.task.id, draft => { for (let n = 0; n < 9; n++) draft.images.push({ id: id(n), name: id(n), url: '' }); });
  await assert.rejects(s.runner.unqueue('P', s.task.id, queued.request, true), { status: 409, detail: 'draft_images_full' });
  assert.deepEqual((await s.store.readQueue('P', s.task.id)).map(item => item.images), [[id(90), id(91)]], 'the queued item and its images stay put');
  assert.equal((await readDraft(ws, 'P', s.task.id)).images.length, 9);
  await updateDraft(ws, 'P', s.task.id, draft => { draft.images.pop(); });
  assert.deepEqual(await s.runner.unqueue('P', s.task.id, queued.request, true), []);
  assert.deepEqual((await readDraft(ws, 'P', s.task.id)).images.slice(-2).map(item => item.id), [id(90), id(91)]);
  await s.runner.stop('P', s.task.id); await s.runner.whenIdle();
}));
test('codex model change starts new session, switching gets unseen handoff, completion approval revoked', () => withTmpWorkspace(async ws => {
  const s = await setup(ws); await s.tasks.update('P', s.task.id, { state: '完成' }); await s.completion.approve('P', s.task.id);
  await s.send('one', { ai: 'codex', model: 'a' }); await s.runner.whenIdle(); assert.equal(await s.completion.isApproved('P', s.task.id), false);
  await s.send('two', { ai: 'codex', model: 'a' }); await s.runner.whenIdle(); assert.ok(s.calls[1]?.resumeId);
  await s.send('three', { ai: 'codex', model: 'b' }); await s.runner.whenIdle(); assert.equal(s.calls[2]?.resumeId, undefined); assert.match(s.calls[2]!.prompt, /背景記錄/u);
  await s.send('four', { ai: 'claude', model: 'c' }); await s.runner.whenIdle(); assert.match(s.calls[3]!.prompt, /three/u);
  await s.send('five', { ai: 'claude', model: 'd' }); await s.runner.whenIdle(); assert.ok(s.calls[4]?.resumeId);
}));
test('concurrent sends reserve slots; queue limit and failed preparation release slot', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 10 });
  const second = await s.tasks.create('P', { title: 'Second', workspace: 'direct' });
  const third = await s.tasks.create('P', { title: 'Third', workspace: 'direct' });
  await Promise.all([s.send('first [slow]'), s.runner.send({ project: 'P', task: second.id, text: 'second [slow]' })]);
  await assert.rejects(s.runner.send({ project: 'P', task: third.id, text: 'over limit' }), /同時執行/u);
  await Promise.all([s.send('q1', { mode: 'queue' }), s.send('q2', { mode: 'queue' }), s.send('q3', { mode: 'queue' })]);
  await assert.rejects(s.send('q4', { mode: 'queue' }), /排隊指示/u);
  await Promise.all([s.runner.stop('P', s.task.id), s.runner.stop('P', second.id)]);
  await assert.rejects(s.runner.send({ project: 'P', task: third.id, text: 'bad image', images: ['bad'] }));
  assert.equal(s.runner.isRunning('P', third.id), false);
  await s.runner.send({ project: 'P', task: third.id, text: 'works' }); await s.runner.whenIdle();
}));

test('核心關閉停止忙碌執行、保留隊列且拒絕新指示', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5, stopMs: 2 });
  await s.send('running [slow]');
  await s.send('keep queued', { mode: 'queue' });
  await s.runner.stopAll();
  await s.runner.whenIdle();
  assert.equal(s.runner.running().length, 0);
  assert.equal((await s.store.readQueue('P', s.task.id))[0]?.text, 'keep queued');
  assert.ok((await s.store.readLog('P', s.task.id)).some(row => row.role === 'assistant' && row.stopped));
  await assert.rejects(s.send('rejected'), { code: 'unavailable' });
}));

test('執行開始持久化 marker，正常完成後清除', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5 });
  const sent = await s.send('running [slow]');
  const running = (await s.store.readMeta('P', s.task.id)).running;
  assert.equal(running?.request, sent.request);
  assert.equal(running?.ai, 'codex');
  await s.runner.whenIdle();
  assert.equal((await s.store.readMeta('P', s.task.id)).running, undefined);
}));

test('失敗續聊清除 session 與模型、不推進 seen，下輪附完整交接', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const first = await s.send('first successful instruction');
  await s.runner.whenIdle();
  const initial = await s.store.readMeta('P', s.task.id);
  assert.ok(initial.sessions.codex);
  assert.equal(initial.seen.codex, first.request);
  await s.send('broken resume [fail]');
  await s.runner.whenIdle();
  const failed = await s.store.readMeta('P', s.task.id);
  assert.equal(failed.sessions.codex, undefined);
  assert.equal(failed.models.codex, undefined);
  assert.equal(failed.seen.codex, first.request);
  const failedRow = (await s.store.readLog('P', s.task.id)).at(-1);
  assert.ok(failedRow?.role === 'assistant');
  assert.equal(failedRow.error, 'cli_failed');
  await s.send('next instruction');
  await s.runner.whenIdle();
  assert.equal(s.calls[2]?.resumeId, undefined);
  assert.match(s.calls[2]!.prompt, /first successful instruction/u);
  assert.match(s.calls[2]!.prompt, /broken resume/u);
  assert.ok((await s.store.readMeta('P', s.task.id)).sessions.codex);
}));

test('新回合失敗不保存新 session，人工停止仍保留 session', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  await s.send('fresh [fail]');
  await s.runner.whenIdle();
  const failed = await s.store.readMeta('P', s.task.id);
  assert.equal(failed.sessions.codex, undefined);
  assert.equal(failed.seen.codex, undefined);
  const stopped = await s.send('human stop [slow]');
  await s.runner.stop('P', s.task.id);
  await s.runner.whenIdle();
  const meta = await s.store.readMeta('P', s.task.id);
  assert.ok(meta.sessions.codex);
  assert.equal(meta.seen.codex, stopped.request);
}));

test('內部執行失敗也清除 resume、保留原 seen 並清除 marker', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, {
    text: opts => {
      if (opts.resumeId) throw new Error('scripted internal failure');
      return 'ok';
    },
  });
  const first = await s.send('first');
  await s.runner.whenIdle();
  await s.send('second');
  await s.runner.whenIdle();
  const meta = await s.store.readMeta('P', s.task.id);
  assert.equal(meta.sessions.codex, undefined);
  assert.equal(meta.models.codex, undefined);
  assert.equal(meta.seen.codex, first.request);
  assert.equal(meta.running, undefined);
  const failedRow = (await s.store.readLog('P', s.task.id)).at(-1);
  assert.ok(failedRow?.role === 'assistant');
  assert.equal(failedRow.error, 'internal');
}));

test('啟動前追加失敗不留下 running marker 或中斷回覆', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const append = s.store.append.bind(s.store);
  s.store.append = async () => { throw new Error('append failed'); };
  await assert.rejects(s.send('cannot append'), /append failed/u);
  assert.equal(s.runner.isRunning('P', s.task.id), false);
  assert.equal((await s.store.readMeta('P', s.task.id)).running, undefined);
  s.store.append = append;
  await s.store.recoverInterrupted();
  assert.deepEqual(await s.store.readLog('P', s.task.id), []);
  await s.send('retry normally');
  await s.runner.whenIdle();
  assert.equal((await s.store.readLog('P', s.task.id)).at(-1)?.text, 'ok');
}));

test('queued instruction that fails before its turn starts stays queued with the error', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5 });
  const append = s.store.append.bind(s.store);
  s.store.append = async (p, t, row) => { if (row.role === 'user' && row.text === 'queued') throw new Error('disk failure'); await append(p, t, row); };
  await s.send('slow [slow]'); const queued = await s.send('queued', { mode: 'queue' });
  await s.runner.whenIdle();
  assert.deepEqual((await s.store.readQueue('P', s.task.id)).map(item => [item.id, item.error]), [[queued.request, 'internal']]);
  assert.equal((await s.store.readLog('P', s.task.id)).some(row => row.role === 'user' && row.text === 'queued'), false);
  // An explicit retry that fails again keeps the item; once storage recovers it runs exactly once.
  await assert.rejects(s.send('', { fromQueue: queued.request }), /disk failure/u);
  assert.equal((await s.store.readQueue('P', s.task.id)).length, 1);
  s.store.append = append;
  await s.send('', { fromQueue: queued.request }); await s.runner.whenIdle();
  assert.deepEqual(await s.store.readQueue('P', s.task.id), []);
  assert.equal((await s.store.readLog('P', s.task.id)).filter(row => row.role === 'user' && row.text === 'queued').length, 1);
}));

test('a launch failure after the instruction was recorded closes the turn instead of leaving it running', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const writeMeta = s.store.writeMeta.bind(s.store); let failed = false;
  s.store.writeMeta = async (p, t, meta) => { if (!failed && meta.running) { failed = true; throw new Error('disk failure'); } await writeMeta(p, t, meta); };
  const sent = s.send('first');
  await assert.rejects(sent, /disk failure/u);
  // Clients saw `busy` for this request, so they must also see it end, with a failed reply in the transcript.
  const busy = s.events.find(e => e.event === 'busy'); assert.ok(busy?.event === 'busy');
  assert.ok(s.events.some(e => e.event === 'idle' && e.data.request === busy.data.request));
  const rows = await s.store.readLog('P', s.task.id);
  assert.deepEqual(rows.map(row => row.role === 'assistant' ? [row.role, row.request, row.error] : [row.role, row.request]), [['user', busy.data.request], ['assistant', busy.data.request, 'internal']]);
  assert.equal(s.runner.isRunning('P', s.task.id), false);
  await s.send('second'); await s.runner.whenIdle();
  assert.equal((await s.store.readLog('P', s.task.id)).at(-1)?.text, 'ok');
}));

test('歷史分頁與 snapshot 邊界依解析後行索引計算', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const rows = Array.from({ length: HISTORY_PAGE * 2 + 1 }, (_, index) => ({
    role: 'assistant', ai: 'codex', at: 'now', request: String(index), text: String(index), ms: 1,
  }));
  await fs.writeFile(ws.chatFile('P', s.task.id, 'jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\nbad line\n');
  const snapshot = await s.runner.snapshot('P', s.task.id);
  assert.equal(snapshot.start, HISTORY_PAGE + 1);
  assert.deepEqual(snapshot.rows.map(row => row.text), rows.slice(HISTORY_PAGE + 1).map(row => row.text));
  assert.deepEqual(await s.runner.history('P', s.task.id, 0), { rows: [], start: 0 });
  for (const before of [1, HISTORY_PAGE, HISTORY_PAGE + 1, HISTORY_PAGE * 2, rows.length + 100]) {
    const page = await s.runner.history('P', s.task.id, before);
    const end = Math.min(before, rows.length);
    assert.equal(page.start, Math.max(0, end - HISTORY_PAGE));
    assert.deepEqual(page.rows, rows.slice(page.start, end));
  }
  for (const before of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(s.runner.history('P', s.task.id, before), { code: 'bad_request', detail: 'field_type', field: 'before' });
  }
  await assert.rejects(s.runner.history('P', '20260101-999', 0), { code: 'not_found' });
}));

test('history 路由驗證 before 字串及作業存在', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const handlers = new Map<string, Handler>();
  const router = {
    get: (route: string, handler: Handler) => { handlers.set(route, handler); },
    post: () => {}, postRaw: () => {},
  } as unknown as Router;
  registerChatRoutes(router, {
    runner: s.runner, config: DEFAULT_CONFIG,
  } as unknown as App);
  const handler = handlers.get('/api/chat/history')!;
  const request = (before?: string, task = s.task.id) => {
    const query = new URLSearchParams({ project: 'P', task });
    if (before !== undefined) query.set('before', before);
    return handler({ query } as Ctx);
  };
  assert.deepEqual(await request('0'), { rows: [], start: 0 });
  for (const before of [undefined, '', '-1', '1.5', '1e2', '+1', ' 1', '9007199254740992']) {
    await assert.rejects(request(before), { code: 'bad_request', detail: 'field_type', field: 'before' });
  }
  await assert.rejects(request('0', '20260101-999'), { code: 'not_found' });
}));

test('usage survives successful, failed, and stopped turns', () => withTmpWorkspace(async ws => {
  const usage = { input: 11, output: 12, cached: 3 };
  const s = await setup(ws, { events: [{ type: 'usage', usage }] });
  await s.send('normal'); await s.runner.whenIdle();
  await s.send('broken [fail]'); await s.runner.whenIdle();
  const started = Promise.withResolvers<void>();
  s.runner.on('event', (_p, _t, event: ChatEvent) => {
    if (event.event === 'delta') started.resolve();
  });
  await s.send('stop [slow]');
  await started.promise;
  await s.runner.stop('P', s.task.id); await s.runner.whenIdle();
  const rows = (await s.store.readLog('P', s.task.id)).filter(r => r.role === 'assistant');
  assert.equal(rows.length, 3);
  for (const row of rows) assert.deepEqual(row.usage, usage);
  assert.equal(rows[1]?.error, 'cli_failed');
  assert.equal(rows[2]?.stopped, true);
}));

test('terminal persistence and marker cleanup fail independently without losing idle', () => withTmpWorkspace(async ws => {
  for (const failure of ['meta', 'append'] as const) {
    const s = await setup(ws, { events: [{ type: 'tool', text: 'Read' }] });
    const append = s.store.append.bind(s.store);
    const writeMeta = s.store.writeMeta.bind(s.store);
    s.store.append = async (p, t, row) => {
      if (row.role === 'event' || (failure === 'append' && row.role === 'assistant')) throw new Error('disk failure');
      await append(p, t, row);
    };
    s.store.writeMeta = async (p, t, meta) => {
      if (failure === 'meta' && !meta.running) throw new Error('disk failure');
      await writeMeta(p, t, meta);
    };
    await s.send('go'); await s.runner.whenIdle();
    assert.equal(s.runner.isRunning('P', s.task.id), false);
    assert.ok(s.events.some(e => e.event === 'idle'));
    assert.ok(s.events.some(e => e.event === 'row' && e.data.role === 'assistant' && e.data.error === 'internal'));
    if (failure === 'meta') assert.equal((await s.store.readLog('P', s.task.id)).at(-1)?.role, 'assistant');
    else assert.equal((await s.store.readMeta('P', s.task.id)).running, undefined);
    await fs.rm(ws.projectDir('P'), { recursive: true });
  }
}));

test('transient terminal append or metadata failure clears marker without duplicate replies', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { events: [{ type: 'usage', usage: { input: 3, output: 4 } }] });
  const append = s.store.append.bind(s.store);
  let appendFailed = false;
  s.store.append = async (p, t, row) => {
    if (row.role === 'assistant' && !appendFailed) {
      appendFailed = true;
      throw new Error('transient disk failure');
    }
    await append(p, t, row);
  };
  await s.send('append failure'); await s.runner.whenIdle();
  assert.equal((await s.store.readMeta('P', s.task.id)).running, undefined);
  const failed = (await s.store.readLog('P', s.task.id)).filter(r => r.role === 'assistant');
  assert.equal(failed.length, 1); assert.equal(failed[0]?.error, 'internal');
  assert.deepEqual(failed[0]?.usage, { input: 3, output: 4 });
  const writeMeta = s.store.writeMeta.bind(s.store);
  let metaFailed = false;
  s.store.writeMeta = async (p, t, meta) => {
    if (!meta.running && !metaFailed) {
      metaFailed = true;
      throw new Error('transient disk failure');
    }
    await writeMeta(p, t, meta);
  };
  await s.send('metadata failure'); await s.runner.whenIdle();
  assert.equal((await s.store.readMeta('P', s.task.id)).running, undefined);
  assert.equal((await s.store.readLog('P', s.task.id)).filter(r => r.role === 'assistant').length, 2);
}));

test('idle slots and locks are reclaimed without racing a new send', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const maps = s.runner as unknown as { slots: Map<string, unknown>; locks: Map<string, unknown> };
  await s.send('first'); await s.runner.whenIdle();
  assert.equal(maps.slots.size, 0); assert.equal(maps.locks.size, 0);
  await s.runner.snapshot('P', s.task.id);
  s.runner.isRunning('P', s.task.id);
  assert.equal(maps.slots.size, 0);
  const readQueue = s.store.readQueue.bind(s.store);
  let arrived = false;
  let send: Promise<unknown> | undefined;
  s.store.readQueue = async (p, t) => {
    if (!arrived) {
      arrived = true;
      send = s.send('arrived during cleanup', { mode: 'queue' });
    }
    return readQueue(p, t);
  };
  await s.send('second');
  await send; await s.runner.whenIdle();
  const users = (await s.store.readLog('P', s.task.id)).filter(r => r.role === 'user');
  assert.equal(users.length, 3);
  assert.equal(maps.slots.size, 0); assert.equal(maps.locks.size, 0);
}));

async function autoFixSetup(ws: Workspace, autoFix: number, results: boolean[], options: MockOptions = {}) {
  const s = await setup(ws, options);
  await new ProjectLedger(ws).update('P', { verify: 'npm test', autoFix });
  const verified: string[] = [];
  (s.runner as unknown as { deps: { verify: () => Promise<VerifyResult> } }).deps.verify = async () => {
    const ok = results[Math.min(verified.length, results.length - 1)]!;
    verified.push(ok ? 'ok' : 'fail');
    return { ok, exitCode: ok ? 0 : 1, timedOut: false, ms: 1, output: `run ${verified.length} output`, truncated: false };
  };
  const users = async () => (await s.store.readLog('P', s.task.id)).filter(r => r.role === 'user').map(r => r.text);
  return { ...s, verified, users };
}

test('驗證持續失敗時自動修正到上限就停，每次都附上輸出與次數', () => withTmpWorkspace(async ws => {
  const s = await autoFixSetup(ws, 2, [false]);
  await s.send('build it'); await s.runner.whenIdle();
  const users = await s.users();
  assert.equal(users.length, 3);
  assert.match(users[1]!, /第 1\/2 次自動修正[\s\S]*run 1 output/u);
  assert.match(users[2]!, /第 2\/2 次自動修正[\s\S]*run 2 output/u);
  assert.equal(s.verified.length, 3);
  const task = await s.tasks.get('P', s.task.id);
  assert.equal(task.state, '等待回覆'); assert.match(task.question, /2 次自動修正後仍失敗/u);
}));

test('驗證通過就不再修正；人下新指示後次數重新計算', () => withTmpWorkspace(async ws => {
  const s = await autoFixSetup(ws, 1, [false, true, false, false]);
  await s.send('first'); await s.runner.whenIdle();
  assert.equal((await s.users()).length, 2);
  await s.send('second'); await s.runner.whenIdle();
  assert.equal((await s.users()).length, 4);
  assert.deepEqual(s.verified, ['fail', 'ok', 'fail', 'fail']);
}));

for (const [name, autoFix, text, instruction] of [
  ['autoFix 為 0', 0, undefined, 'plain'],
  ['執行失敗', 2, undefined, 'broken [fail]'],
  ['等待回答', 2, 'done\n[[question]]\nWhich?\n1. A\n2. B\n[[/question]]', 'go'],
] as const) {
  test(`${name}時不自動驗證`, () => withTmpWorkspace(async ws => {
    const s = await autoFixSetup(ws, autoFix, [false], text ? { text } : {});
    await s.send(instruction); await s.runner.whenIdle();
    assert.equal(s.verified.length, 0);
  }));
}

test('profile switches isolate sessions and failed switches retain the previous binding', () => withTmpWorkspace(async (ws, dir) => {
  const s = await setup(ws);
  const configDir = path.join(dir, 'profile');
  await fs.mkdir(configDir);
  const added = await s.settings.addAccount('codex', 'Other', configDir);
  const account = added.accounts.codex![0]!;
  await s.settings.update({ activeAccounts: { codex: 'default' } });
  await s.send('default first'); await s.runner.whenIdle();
  const original = await s.store.readMeta('P', s.task.id);
  await s.settings.update({ activeAccounts: { codex: account.id } });
  await s.send('failed switch [fail]'); await s.runner.whenIdle();
  assert.equal(s.calls[1]!.resumeId, undefined);
  assert.equal(s.calls[1]!.configDir, undefined);
  assert.deepEqual(await s.store.readMeta('P', s.task.id), original);
  await s.settings.update({ activeAccounts: { codex: 'default' } });
  await s.send('default continued'); await s.runner.whenIdle();
  assert.equal(s.calls[2]!.resumeId, original.sessions.codex);
  await s.settings.update({ activeAccounts: { codex: account.id } });
  await s.send('other first'); await s.runner.whenIdle();
  assert.equal(s.calls[3]!.resumeId, undefined);
  assert.match(s.calls[3]!.prompt, /default first/u);
  const other = await s.store.readMeta('P', s.task.id);
  assert.equal(other.accounts?.codex, account.id);
  await s.send('other continued'); await s.runner.whenIdle();
  assert.equal(s.calls[4]!.resumeId, other.sessions.codex);
  await s.settings.update({ activeAccounts: { codex: 'default' } });
  await s.send('back to default'); await s.runner.whenIdle();
  assert.equal(s.calls[5]!.resumeId, undefined);
  assert.equal(s.calls[5]!.configDir, undefined);
  assert.equal(s.calls[5]!.accountId, 'default');
}));

test('changing active profile during a run only affects the next send', () => withTmpWorkspace(async (ws, dir) => {
  const s = await setup(ws, { chunkMs: 3, events: [{ type: 'tokens', runId: 'sample', count: 4, spanMs: 100, at: 100 }] });
  const target = path.join(dir, 'profile');
  const configDir = path.join(dir, 'profile-alias');
  await fs.mkdir(target); await fs.symlink(target, configDir);
  const account = (await s.settings.addAccount('claude', 'Other', configDir)).accounts.claude![0]!;
  assert.equal(account.configDir, configDir);
  await assert.rejects(s.settings.addAccount('claude', 'Duplicate target', target), { code: 'conflict' });
  await s.settings.update({ activeAccounts: { claude: 'default' } });
  await s.send('old run [slow]', { ai: 'claude' });
  await s.settings.update({ activeAccounts: { claude: account.id } });
  await s.runner.whenIdle();
  assert.deepEqual(s.usageAccounts, ['default']);
  assert.equal(s.calls[0]!.accountId, 'default');
  assert.equal(s.calls[0]!.configDir, undefined);
  assert.equal((await s.store.readMeta('P', s.task.id)).accounts?.claude, 'default');
  await s.send('new run', { ai: 'claude' }); await s.runner.whenIdle();
  assert.equal(s.calls[1]!.accountId, account.id);
  assert.equal(s.calls[1]!.configDir, undefined);
  assert.equal(s.calls[1]!.resumeId, undefined);
  assert.deepEqual(s.usageAccounts, ['default', account.id]);
}));

test('stop during preparation cancels the pending launch and permits a fresh send', { timeout: 5000 }, () => withTmpWorkspace(async ws => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  let first = true;
  const s = await setup(ws, {}, 600, { worktree: {
    prepare: async () => { if (first) { first = false; entered.resolve(); return release.promise; } return ws.projectDir('P'); },
    checkpoint: async () => undefined,
  } as unknown as WorktreeService });
  const sending = s.send('cancel before launch');
  const rejected = assert.rejects(sending, { detail: 'chat_stopped' });
  await entered.promise;
  const stopping = s.runner.stop('P', s.task.id);
  release.resolve(ws.projectDir('P'));
  await rejected;
  assert.equal(await stopping, true);
  assert.equal(s.calls.length, 0);
  assert.equal(s.runner.isRunning('P', s.task.id), false);
  await s.send('fresh request');
  await s.runner.whenTaskIdle('P', s.task.id);
  assert.equal(s.calls.length, 1);
}));

test('task idle waits through queued followups without waiting for unrelated runs', { timeout: 5000 }, () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 1 });
  const other = await s.tasks.create('P', { title: 'Other', workspace: 'direct' });
  const unrelated = Promise.withResolvers<RunOutcome>();
  const first = Promise.withResolvers<RunOutcome>();
  Object.assign(s.mock, { send: (opts: SendOptions, onEvent: (event: CliEvent) => void) => {
    if (opts.prompt.includes('unrelated')) return { done: unrelated.promise, stop: () => unrelated.resolve({ ok: false, stopped: true }) };
    onEvent({ type: 'result', text: 'ok' });
    return { done: opts.prompt.includes('queued followup') ? Promise.resolve({ ok: true, stopped: false }) : first.promise,
      stop: () => first.resolve({ ok: false, stopped: true }) };
  } });
  await s.runner.send({ project: 'P', task: other.id, text: 'unrelated [slow]' });
  try {
    await s.send('first');
    await s.send('queued followup', { mode: 'queue' });
    first.resolve({ ok: true, stopped: false });
    await s.runner.whenTaskIdle('P', s.task.id);
    assert.ok((await s.store.readLog('P', s.task.id)).some(row => row.role === 'user' && row.text === 'queued followup'));
    assert.equal(s.runner.isRunning('P', s.task.id), false);
    assert.equal(s.runner.isRunning('P', other.id), true);
  } finally { await s.runner.stop('P', other.id); await s.runner.whenIdle(); }
}));

test('workflow stop during awaited availability prevents writing and review launches', { timeout: 5000 }, () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  for (const review of [false, true]) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    let reviews = 0;
    const workflow = new WorkflowService({ ws, tasks: s.tasks, completion: s.completion, runner: s.runner,
      store: s.store,
      beforeStart: async () => {}, prepareBranch: async (p, t) => { await s.worktree.prepare(p, t); },
      isTaskBusy: (p, t) => s.runner.isRunning(p, t), maxParallel: 2,
      roles: async () => ({ roles: { worker: { main: { cli: 'codex', model: 'm', effort: 'high' }, job: '' } } }),
      available: () => { entered.resolve(); return release.promise; },
      review: async () => { reviews++; return { request: 'review', ai: 'codex', text: '', ok: true, approved: false, structured: false }; },
      stopReview: () => false, changed() {}, promptChars: 1000 });
    await workflow.configure('P', s.task.id, [], [{ role: 'worker', text: 'do work', review }]);
    await workflow.start('P', s.task.id);
    await entered.promise;
    const stopping = workflow.stop('P', s.task.id);
    release.resolve(true);
    await stopping;
    assert.equal(s.calls.length, 0);
    assert.equal(reviews, 0);
    const plan = await workflow.get('P', s.task.id);
    assert.equal(plan.state, 'paused'); assert.equal(plan.reason, 'workflow_stopped'); assert.equal(plan.cursor, 0);
  }
}));

test('task idle includes automatic verification and its followup run', { timeout: 5000 }, () => withTmpWorkspace(async ws => {
  const verifying = Promise.withResolvers<void>();
  const release = Promise.withResolvers<VerifyResult>();
  let verifications = 0;
  const s = await setup(ws, {}, 600, { verify: async () => {
    verifications++;
    if (verifications === 1) { verifying.resolve(); return release.promise; }
    return { ok: true, exitCode: 0, output: '', ms: 0, timedOut: false, truncated: false };
  } });
  await s.projects.update('P', { verify: 'verify', autoFix: 1 });
  await s.send('initial');
  await verifying.promise;
  let idle = false;
  const waiting = s.runner.whenTaskIdle('P', s.task.id).then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  release.resolve({ ok: false, exitCode: 1, output: 'failure', ms: 0, timedOut: false, truncated: false });
  await waiting;
  assert.equal(s.calls.length, 2);
  assert.equal(verifications, 2);
}));

test('workflow completes consecutive steps while another task stays active', { timeout: 5000 }, () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const other = await s.tasks.create('P', { title: 'Other', workspace: 'direct' });
  const unrelated = Promise.withResolvers<RunOutcome>();
  Object.assign(s.mock, { send: (opts: SendOptions, onEvent: (event: CliEvent) => void) => {
    if (opts.prompt.includes('unrelated')) return { done: unrelated.promise, stop: () => unrelated.resolve({ ok: false, stopped: true }) };
    onEvent({ type: 'result', text: 'ok' });
    return { done: Promise.resolve({ ok: true, stopped: false }), stop() {} };
  } });
  const completed = Promise.withResolvers<void>();
  let started = false;
  const workflow = new WorkflowService({ ws, tasks: s.tasks, completion: s.completion, runner: s.runner,
    store: s.store,
    beforeStart: async () => {}, prepareBranch: async (p, t) => { await s.worktree.prepare(p, t); },
    isTaskBusy: (p, t) => s.runner.isRunning(p, t), maxParallel: 2,
    roles: async () => ({ roles: { worker: { main: { cli: 'codex', model: 'm', effort: 'high' }, job: '' } } }),
    available: async () => true, review: async () => { throw new Error('unexpected review'); }, stopReview: () => false,
    changed: () => { if (started && !workflow.isBusy('P', s.task.id)) completed.resolve(); }, promptChars: 1000 });
  await workflow.configure('P', s.task.id, [], [{ role: 'worker', text: 'one', review: false }, { role: 'worker', text: 'two', review: false }]);
  await s.runner.send({ project: 'P', task: other.id, text: 'unrelated' });
  try {
    started = true;
    await workflow.start('P', s.task.id);
    await completed.promise;
    const plan = await workflow.get('P', s.task.id);
    assert.equal(plan.state, 'completed'); assert.equal(plan.cursor, 2); assert.equal(plan.results.length, 2);
    assert.equal(s.runner.isRunning('P', other.id), true);
  } finally { await workflow.close(); await s.runner.stop('P', other.id); await s.runner.whenIdle(); }
}));

test('workflow stop during initial dependency load waits for reservation and never launches', { timeout: 5000 }, () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  const workflow = new WorkflowService({ ws, tasks: s.tasks, completion: s.completion, runner: s.runner,
    store: s.store,
    beforeStart: async () => {}, prepareBranch: async (p, t) => { await s.worktree.prepare(p, t); },
    isTaskBusy: (p, t) => s.runner.isRunning(p, t), maxParallel: 2,
    roles: async () => ({ roles: { worker: { main: { cli: 'codex', model: 'm', effort: 'high' }, job: '' } } }),
    available: async () => true, review: async () => { throw new Error('unexpected review'); }, stopReview: () => false,
    changed() {}, promptChars: 1000 });
  await workflow.configure('P', s.task.id, [], [{ role: 'worker', text: 'one', review: false }]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const get = s.tasks.get.bind(s.tasks);
  let first = true;
  s.tasks.get = async (p, t) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return get(p, t);
  };
  const starting = workflow.start('P', s.task.id);
  await entered.promise;
  let stopped = false;
  const stopping = workflow.stop('P', s.task.id).then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  await starting; await stopping;
  assert.equal(s.calls.length, 0);
  assert.equal(workflow.isBusy(), false);
  assert.equal((await workflow.get('P', s.task.id)).reason, 'workflow_stopped');
}));

test('named checks participate in automatic verification and correction', () => withTmpWorkspace(async ws => {
  let verifications = 0;
  const s = await setup(ws, {}, 600, { verify: async () => {
    verifications++;
    return { ok: verifications > 1, exitCode: verifications > 1 ? 0 : 1, output: 'named check failure', ms: 0, timedOut: false, truncated: false };
  } });
  await s.projects.update('P', { checks: [{ name: 'types', command: 'typecheck' }], autoFix: 1 });
  await s.send('initial');
  await s.runner.whenTaskIdle('P', s.task.id);
  assert.equal(verifications, 2);
  assert.equal(s.calls.length, 2);
}));

test('workflow outcomes survive more than one history page of automatic-fix tools', { timeout: 5000 }, () => withTmpWorkspace(async ws => {
  let verifications = 0;
  const s = await setup(ws, {}, 600, { verify: async () => {
    verifications++;
    return { ok: verifications > 1, exitCode: verifications > 1 ? 0 : 1, output: 'failure', ms: 0, timedOut: false, truncated: false };
  } });
  await s.projects.update('P', { verify: 'verify', autoFix: 1 });
  let runs = 0;
  Object.assign(s.mock, { send: (_options: SendOptions, onEvent: (event: CliEvent) => void) => {
    if (++runs === 2) for (let index = 0; index < HISTORY_PAGE + 1; index++) onEvent({ type: 'tool', text: `Read file-${index}` });
    onEvent({ type: 'result', text: 'ok' });
    return { done: Promise.resolve({ ok: true, stopped: false }), stop() {} };
  } });
  const completed = Promise.withResolvers<void>();
  let started = false;
  const workflow = new WorkflowService({ ws, tasks: s.tasks, completion: s.completion, runner: s.runner,
    store: s.store,
    beforeStart: async () => {}, prepareBranch: async (p, t) => { await s.worktree.prepare(p, t); },
    isTaskBusy: (p, t) => s.runner.isRunning(p, t), maxParallel: 2,
    roles: async () => ({ roles: { worker: { main: { cli: 'codex', model: 'm', effort: 'high' }, job: '' } } }),
    available: async () => true, review: async () => { throw new Error('unexpected review'); }, stopReview: () => false,
    changed: () => { if (started && !workflow.isBusy('P', s.task.id)) completed.resolve(); }, promptChars: 1000 });
  try {
    await workflow.configure('P', s.task.id, [], [{ role: 'worker', text: 'do work', review: false }]);
    started = true;
    await workflow.start('P', s.task.id); await completed.promise;
    const plan = await workflow.get('P', s.task.id);
    assert.equal(runs, 2); assert.equal(verifications, 2);
    assert.equal(plan.state, 'completed'); assert.equal(plan.cursor, 1);
  } finally { await workflow.close(); }
}));

test('review steps require explicit approval and edits/reruns preserve prior attempts', () => withTmpWorkspace(async ws => {
  const s = await setup(ws);
  let approved = false;
  let finished = Promise.withResolvers<void>();
  const workflow = new WorkflowService({ ws, tasks: s.tasks, completion: s.completion, runner: s.runner,
    store: s.store,
    beforeStart: async () => {}, prepareBranch: async (p, t) => { await s.worktree.prepare(p, t); },
    isTaskBusy: (p, t) => s.runner.isRunning(p, t), maxParallel: 2,
    roles: async () => ({ roles: { reviewer: { main: { cli: 'codex', model: 'm', effort: 'high' }, job: '' } } }),
    available: async () => true,
    review: async () => ({ request: String(approved), ai: 'codex', text: approved ? 'structured approval' : 'APPROVED', ok: true, structured: approved, approved }),
    stopReview: () => false, changed: () => { if (!workflow.isBusy('P', s.task.id)) finished.resolve(); }, promptChars: 1000 });
  await workflow.configure('P', s.task.id, [], [{ role: 'reviewer', text: 'first', review: true }, { role: 'reviewer', text: 'next', review: true }]);
  finished = Promise.withResolvers<void>();
  await workflow.start('P', s.task.id); await finished.promise;
  const failed = await workflow.get('P', s.task.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.nodeStates?.['step-1'], 'failed'); assert.equal(failed.nodeStates?.['step-2'], 'skipped'); assert.equal(failed.results[0]?.ok, false);
  const edited = await workflow.configure('P', s.task.id, [], [{ role: 'reviewer', text: 'retry', review: true }]);
  assert.equal(edited.results.length, 1);
  approved = true; finished = Promise.withResolvers<void>();
  await workflow.start('P', s.task.id); await finished.promise;
  const completed = await workflow.get('P', s.task.id);
  assert.equal(completed.state, 'completed'); assert.equal(completed.results.length, 2);
  await assert.rejects(workflow.configure('P', s.task.id, [], [{ role: 'reviewer', text: 'replace completed', review: true }]));
  const rerun = await workflow.rerun('P', s.task.id, 0);
  assert.equal(rerun.cursor, 0); assert.equal(rerun.results.length, 2);
  assert.ok(rerun.results.every(result => result.invalidatedAt));
  await workflow.close();
}));

test('interrupted workflow recovery is durable and human approval requires saved evidence', () => withTmpWorkspace(async ws => {
  const s = await setup(ws); let finished = Promise.withResolvers<void>();
  const deps = { ws, tasks: s.tasks, completion: s.completion, runner: s.runner,
    store: s.store,
    beforeStart: async () => {}, prepareBranch: async (p: string, t: string) => { await s.worktree.prepare(p, t); },
    isTaskBusy: (p: string, t: string) => s.runner.isRunning(p, t), maxParallel: 2,
    roles: async () => ({ roles: { human: { main: { cli: '人', model: '', effort: '' }, job: '' } } }),
    available: async () => true, review: async () => { throw new Error('unexpected review'); }, stopReview: () => false,
    changed: () => { if (!workflow.isBusy('P', s.task.id)) finished.resolve(); }, promptChars: 1000 };
  const workflow = new WorkflowService(deps);
  const plan = await workflow.configure('P', s.task.id, [], [{ role: 'human', text: 'confirm evidence', review: true }]);
  const file = path.join(ws.projectDir('P'), '.ai', 'workflows', `${s.task.id}.json`);
  await fs.writeFile(file, JSON.stringify({ ...plan, state: 'running' }));
  assert.equal((await workflow.get('P', s.task.id)).state, 'paused');
  const persisted: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(persisted && typeof persisted === 'object' && 'state' in persisted);
  assert.equal(persisted.state, 'paused');
  finished = Promise.withResolvers<void>(); await workflow.start('P', s.task.id); await finished.promise;
  await assert.rejects(workflow.approveHuman('P', s.task.id, ''));
  const approved = await workflow.approveHuman('P', s.task.id, 'Inspected a.ts lines 1–10 and passing verification');
  assert.equal(approved.state, 'completed'); assert.match(approved.results[0]?.evidence ?? '', /Inspected/);
  assert.equal((await new WorkflowService(deps).get('P', s.task.id)).results[0]?.approved, true);
  await workflow.close();
}));

test('redo admission includes final usage of the interrupted turn and retains the unsent replacement', () => withTmpWorkspace(async ws => {
  const history = new UsageHistory(ws.root);
  await history.saveSettings({ rules: [{ id: 'project', project: 'P', unit: 'tokens', threshold: 10, since: '2020-01-01T00:00:00.000Z' }], quotaRemainingPercent: null, cloudExpiryHours: null });
  const reported = Promise.withResolvers<void>();
  const s = await setup(ws, { chunkMs: 5, events: [{ type: 'usage', usage: { input: 12, output: 8 } }, { type: 'tokens', runId: 'first', count: 8, spanMs: 20, at: Date.now() }] }, 600, {
    beforeLaunch: (project, task, ai, account) => history.assertProceed({ project, task, ai, account }, { ais: [], tokensPerSecond: null }),
    onCompleted: input => history.record(input),
    onUsage: (_ai, event) => { if (event.type === 'tokens') reported.resolve(); },
  });
  try {
    await s.send('first [slow]'); await reported.promise;
    await assert.rejects(s.send('replacement', { mode: 'redo' }), (error: unknown) => error instanceof AppError && error.detail === 'usage_ack_required');
    await s.runner.whenIdle();
    assert.equal(s.runner.isRunning('P', s.task.id), false);
    const log = await s.store.readLog('P', s.task.id);
    assert.equal(log.filter(row => row.role === 'user').length, 1); const reply = log.at(-1); assert.ok(reply?.role === 'assistant'); assert.equal(reply.stopped, true);
    const totals = (await history.view()).totals;
    assert.equal(totals[0]!.input + totals[0]!.output, 20);
  } finally { await s.runner.stopAll(); }
}));

for (const decision of ['approve', 'deny', 'timeout', 'stop', 'unsupported', 'turn', 'redo'] as const) {
  test(`tool permission broker: ${decision}`, () => withTmpWorkspace(async ws => {
    const answers: boolean[] = [];
    const { promise: waiting, resolve } = Promise.withResolvers<string>();
    const s = await setup(ws, {
      permissions: [{ tool: 'Bash', input: { command: 'echo hello', password: 'never rendered' } }, ...(decision === 'turn' ? [{ tool: 'Bash', input: { command: 'echo again' } }] : [])],
      supportsApprovals: decision !== 'unsupported', onPermission: allow => answers.push(allow),
    }, 600, {
      resolveFullAccess: async () => false,
      limits: { concurrentRuns: 2, queueLength: 3, handoffChars: 60000, imagesPerSend: 10, runSeconds: 600, approvalSeconds: decision === 'timeout' ? 0.02 : 2 },
      publish: (_p, _t, event) => { if (event.event === 'approvals' && event.data[0]) resolve(event.data[0].id); },
    });
    await s.send('permission');
    if (decision === 'unsupported') {
      assert.equal(s.runner.running()[0]?.approvalUnsupported, true);
      await s.runner.whenIdle();
      assert.deepEqual(answers, [false]);
      return;
    }
    const id = await waiting;
    assert.equal(s.runner.running()[0]?.approvals?.[0]?.summary, 'command: echo hello\npassword: [redacted]');
    const snapshot = await s.runner.snapshot('P', s.task.id);
    assert.equal(snapshot.busy?.approvals?.[0]?.id, id);
    if (decision === 'stop') await s.runner.stop('P', s.task.id);
    else if (decision === 'redo') {
      // The replacement request is independently gated; only the old turn is denied.
      const next = s.send('replacement', { mode: 'redo' });
      await next;
      await s.runner.stop('P', s.task.id);
    } else if (decision !== 'timeout') s.runner.approve('P', s.task.id, id, decision !== 'deny', decision === 'turn');
    await s.runner.whenIdle();
    assert.deepEqual(answers, decision === 'turn' ? [true, true] : decision === 'redo' ? [false] : [decision === 'approve']);
    assert.throws(() => s.runner.approve('P', s.task.id, id, true), { code: 'conflict' });
    assert.equal(s.runner.running().length, 0);
  }));
}

test('approval route validates decisions and checks trust before allowing', () => withTmpWorkspace(async ws => {
  const { promise: waiting, resolve } = Promise.withResolvers<string>();
  const answers: boolean[] = [];
  const s = await setup(ws, { permissions: [{ tool: 'Edit', input: { file_path: 'a.ts' } }], onPermission: allow => answers.push(allow) }, 600, {
    resolveFullAccess: async () => false,
    publish: (_p, _t, event) => { if (event.event === 'approvals' && event.data[0]) resolve(event.data[0].id); },
  });
  const routes = new Map<string, Handler>();
  let trusted = false;
  registerChatRoutes({ get: () => {}, postRaw: () => {}, post: (path: string, handler: Handler) => routes.set(path, handler) } as unknown as Router,
    { runner: s.runner, tasks: s.tasks, config: DEFAULT_CONFIG, trust: { assertExecutable: async () => { if (!trusted) throw new AppError('forbidden'); } } } as unknown as App);
  await s.send('edit');
  const id = await waiting;
  const handler = routes.get('/api/chat/approve')!;
  const ctx = (body: Record<string, unknown>) => ({ body } as Ctx);
  await assert.rejects(async () => handler(ctx({ project: 'P', task: s.task.id, id, allow: 'yes' })), { code: 'bad_request' });
  await assert.rejects(async () => handler(ctx({ project: 'P', task: s.task.id, id, allow: true })), { code: 'forbidden' });
  assert.equal(answers.length, 0);
  trusted = true;
  assert.deepEqual(await handler(ctx({ project: 'P', task: s.task.id, id, allow: true })), { ok: true });
  await s.runner.whenIdle();
  assert.deepEqual(answers, [true]);
  await assert.rejects(async () => handler(ctx({ project: 'P', task: s.task.id, id, allow: false })), { code: 'conflict' });
}));
test('workflow resumes an answered AI branch only on explicit start without replaying its instruction', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { text: opts => opts.prompt.includes('answer now') ? 'thanks' : '[[question]]\nWhich?\n1. A\n2. B\n[[/question]]' });
  let finished = Promise.withResolvers<void>();
  const workflow = new WorkflowService({
    ws, tasks: s.tasks, completion: s.completion, runner: s.runner, store: s.store,
    roles: async () => ({ roles: { worker: { main: { cli: 'codex', model: 'm', effort: 'high' }, job: '' } } }),
    available: async () => true, review: async () => { throw new Error('unexpected review'); },
    stopReview: () => false, beforeStart: async () => {},
    prepareBranch: async (p, t) => { await s.worktree.prepare(p, t); },
    isTaskBusy: (p, t) => s.runner.isRunning(p, t), maxParallel: 2, promptChars: 1000,
    changed: () => { if (!workflow.isBusy('P', s.task.id)) finished.resolve(); },
  });
  try {
    await workflow.configure('P', s.task.id, [], [{ id: 'worker', role: 'worker', text: 'initial question', review: false }]);
    finished = Promise.withResolvers<void>();
    await workflow.start('P', s.task.id); await finished.promise;
    let plan = await workflow.get('P', s.task.id);
    assert.equal(plan.nodeStates?.worker, 'human');
    const branch = plan.branchTasks!.worker!;
    finished = Promise.withResolvers<void>();
    await workflow.start('P', s.task.id); await finished.promise;
    assert.equal(s.calls.length, 1);
    await s.runner.send({ project: 'P', task: branch, text: 'answer now', answer: true });
    await s.runner.whenTaskIdle('P', branch);
    assert.equal((await workflow.get('P', s.task.id)).state, 'paused');
    finished = Promise.withResolvers<void>();
    await workflow.start('P', s.task.id); await finished.promise;
    plan = await workflow.get('P', s.task.id);
    assert.equal(plan.state, 'completed'); assert.equal(plan.nodeStates?.worker, 'succeeded');
    assert.equal(plan.results.at(-1)?.output, 'thanks'); assert.equal(s.calls.length, 2);
  } finally { await workflow.close(); await s.runner.stopAll(); }
}));
test('an answer queued behind a running turn still answers the question when it starts', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { chunkMs: 5, text: opts => opts.prompt.includes('ask me') ? 'done\n[[question]]\nWhich?\n1. A\n2. B\n[[/question]]' : 'ok' });
  await s.send('ask me'); await s.runner.whenIdle();
  assert.equal((await s.tasks.get('P', s.task.id)).question, 'Which?');
  // Another instruction is running when the human picks an option; the answer waits in the queue.
  await s.send('slow [slow]');
  const queued = await s.send('A', { mode: 'queue', answer: true });
  assert.equal(queued.queued, true);
  await s.runner.whenIdle();
  const task = await s.tasks.get('P', s.task.id);
  assert.equal(task.question, '');
  const answer = (await s.store.readLog('P', s.task.id)).find(row => row.role === 'user' && row.text === 'A');
  assert.ok(answer?.role === 'user'); assert.equal(answer.mode, 'answer');
}));
