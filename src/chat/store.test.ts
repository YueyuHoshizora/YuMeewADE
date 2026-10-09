import test from 'node:test';
import assert from 'node:assert/strict';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { ChatStore } from './store.ts';

test('重啟補寫 interrupted 回覆且不重試、不改隊列', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T', workspace: 'direct' });
  const store = new ChatStore(ws);
  const running = { request: 'request', ai: 'codex', model: 'm', effort: 'high', startedAt: new Date().toISOString() };
  await store.append('P', task.id, { role: 'user', to: running.ai, at: running.startedAt, request: running.request, text: 'work' });
  await store.writeMeta('P', task.id, { sessions: { codex: 'sid' }, models: { codex: 'm' }, seen: {}, running });
  const queue = [{ id: 'queue', text: 'later', ai: 'codex', at: running.startedAt }];
  await store.updateQueue('P', task.id, () => queue);
  const restarted = new ChatStore(ws);
  await restarted.recoverInterrupted();
  const rows = await restarted.readLog('P', task.id);
  assert.equal(rows.length, 2);
  const row = rows[1];
  assert.ok(row?.role === 'assistant');
  assert.equal(row.error, 'interrupted');
  assert.equal(row.text, '');
  assert.equal(row.ms, 0);
  assert.equal(row.ai, running.ai);
  assert.equal(row.model, running.model);
  assert.equal(row.effort, running.effort);
  assert.equal(row.request, running.request);
  assert.equal((await restarted.readMeta('P', task.id)).running, undefined);
  assert.equal((await restarted.readMeta('P', task.id)).sessions['codex'], 'sid');
  assert.deepEqual(await restarted.readQueue('P', task.id), queue);
  await restarted.recoverInterrupted();
  assert.equal((await restarted.readLog('P', task.id)).length, 2);
}));

test('回覆已落盤但 marker 未清除時重啟不會重複補寫', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T', workspace: 'direct' });
  const store = new ChatStore(ws);
  await store.append('P', task.id, { role: 'assistant', at: 'now', request: 'r', ai: 'codex', text: 'done', ms: 1 });
  await store.writeMeta('P', task.id, { sessions: {}, models: {}, seen: {}, running: { request: 'r', ai: 'codex', model: 'm', effort: 'high', startedAt: 'before' } });
  await store.recoverInterrupted();
  assert.equal((await store.readLog('P', task.id)).length, 1);
  assert.equal((await store.readMeta('P', task.id)).running, undefined);
}));
