import test from 'node:test';
import assert from 'node:assert/strict';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { ChatStore } from './store.ts';
import { promises as fs } from 'node:fs';
import type { ChatRow } from '../shared/types.ts';

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

test('JSONL 快取讀追加尾端、跳過壞行且回傳深層副本', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T', workspace: 'direct' });
  const store = new ChatStore(ws);
  const row: ChatRow = {
    role: 'assistant', ai: 'codex', at: 'now', request: 'r', text: 'first', ms: 1,
    asks: [{ question: 'Q', options: ['A'], multi: false }],
  };
  await store.append('P', task.id, row);
  const first = await store.readLog('P', task.id);
  first[0]!.text = 'mutated';
  assert.ok(first[0]?.role === 'assistant');
  first[0].asks![0]!.options.push('mutated');
  assert.deepEqual(await store.readLog('P', task.id), [row]);
  const second = { ...row, request: 'r2', text: 'second' };
  await fs.appendFile(ws.chatFile('P', task.id, 'jsonl'), `bad line\n${JSON.stringify(second)}\n`);
  assert.deepEqual(await store.readLog('P', task.id), [row, second]);
  await store.append('P', task.id, { ...row, text: 'third' });
  assert.equal((await store.readLog('P', task.id)).at(-1)?.text, 'third');
}));

test('同大小改寫、縮短與不完整尾行都重新解析', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T', workspace: 'direct' });
  const store = new ChatStore(ws);
  const file = ws.chatFile('P', task.id, 'jsonl');
  const row: ChatRow = { role: 'assistant', ai: 'codex', at: 'now', request: 'r', text: 'first', ms: 1 };
  await store.append('P', task.id, row);
  await store.readLog('P', task.id);
  const rewritten = { ...row, text: 'other' };
  await fs.writeFile(file, `${JSON.stringify(rewritten)}\n`);
  await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
  assert.deepEqual(await store.readLog('P', task.id), [rewritten]);
  await fs.writeFile(file, '');
  assert.deepEqual(await store.readLog('P', task.id), []);
  const json = JSON.stringify(row);
  await fs.writeFile(file, json.slice(0, -2));
  assert.deepEqual(await store.readLog('P', task.id), []);
  await fs.appendFile(file, `${json.slice(-2)}\n`);
  assert.deepEqual(await store.readLog('P', task.id), [row]);
}));

test('a message appended after a write was cut short (disk full, crash) is kept, not merged into the fragment', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T', workspace: 'direct' });
  const store = new ChatStore(ws);
  const row = (text: string): ChatRow => ({ role: 'user', to: 'codex', at: 'now', request: text, text });
  await store.append('P', task.id, row('before'));
  await fs.appendFile(ws.chatFile('P', task.id, 'jsonl'), JSON.stringify(row('cut short')).slice(0, 20));
  await store.append('P', task.id, row('after'));
  assert.deepEqual((await store.readLog('P', task.id)).map(r => r.text), ['before', 'after']);
}));
