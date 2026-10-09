import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockCliProvider, type MockOptions } from '../cli/mock.ts';
import type { SendOptions } from '../cli/provider.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { CompletionStore } from '../ledger/completion.ts';
import { SettingsStore } from '../ledger/settings.ts';
import { OpLog } from '../ledger/oplog.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { loadRoles } from '../roles/roles.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { WorktreeService } from '../git/worktree.ts';
import type { ChatEvent } from '../shared/types.ts';
import { ChatRunner } from './runner.ts';
import { ChatStore } from './store.ts';
async function setup(ws: Workspace, options: MockOptions = {}) {
  const projects = new ProjectLedger(ws); await projects.create({ name: 'P' });
  const tasks = new TaskLedger(ws); const task = await tasks.create('P', { title: 'T', workspace: 'direct' });
  const settings = new SettingsStore(ws, DEFAULT_CONFIG); await settings.update({ initial: { ai: 'codex', model: 'm', effort: 'high' } });
  const store = new ChatStore(ws); const calls: SendOptions[] = []; const events: ChatEvent[] = []; let watching = false;
  const mock = new MockCliProvider({ chunkMs: 1, ...options, text: opts => { calls.push(opts); return typeof options.text === 'function' ? options.text(opts) : options.text ?? 'ok'; } });
  const completion = new CompletionStore(ws);
  const runner = new ChatRunner({ ws, store, projects, tasks, settings, completion, oplog: new OpLog(ws), roles: () => loadRoles(ws.rolesFile), providers: { mock, claude: mock, codex: mock }, limits: { concurrentRuns: 2, queueLength: 3, handoffChars: 60000, imagesPerSend: 10 }, worktree: { prepare: async () => ws.projectDir('P') } as unknown as WorktreeService, publish: (_p, _t, ev) => events.push(ev), watching: () => watching, onChanged: () => {} });
  const send = (text: string, extra: Partial<Parameters<ChatRunner['send']>[0]> = {}) => runner.send({ project: 'P', task: task.id, text, ...extra });
  return { runner, store, tasks, task, send, calls, events, completion, watch: () => { watching = true; } };
}
test('roleless defaults, tool rows, asks, answer clearing, unread', () => withTmpWorkspace(async ws => {
  const s = await setup(ws, { text: opts => opts.prompt.includes('answer now') ? 'thanks' : 'done\n[[question]]\nWhich?\n1. A\n2. B\n[[/question]]', events: [{ type: 'tool', text: 'Read file.ts' }] });
  await s.send('go'); await s.runner.whenIdle();
  const task = await s.tasks.get('P', s.task.id); assert.equal(task.cli, 'codex'); assert.equal(task.model, 'm'); assert.equal(task.state, '等待回覆'); assert.equal(task.question, 'Which?');
  const rows = await s.store.readLog('P', s.task.id); assert.equal(rows[0]?.role, 'user'); assert.equal(rows[1]?.role, 'event'); assert.equal(rows[2]?.text, 'done');
  assert.equal(s.runner.unread().length, 1); s.runner.markRead('P', s.task.id); s.watch();
  await s.send('answer now', { answer: true }); await s.runner.whenIdle(); assert.equal((await s.tasks.get('P', s.task.id)).question, ''); assert.equal(s.runner.unread().length, 0);
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
