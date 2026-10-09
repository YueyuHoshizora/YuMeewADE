import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { MockCliProvider } from '../cli/mock.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { parseRoles } from '../roles/roles.ts';
import { AppError } from '../shared/errors.ts';
import type { SseEvent } from '../shared/types.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ChatRunner, unseenRows } from './runner.ts';
import { ChatStore } from './store.ts';

const ROLES = parseRoles('roles:\n  實作: { main: [mock, default, high], job: 寫碼 }\n');

async function setup(ws: Parameters<Parameters<typeof withTmpWorkspace>[0]>[0], limits = { concurrentRuns: 2, queueLength: 3, handoffChars: 24_000 }) {
  await new ProjectLedger(ws).create('P');
  const tasks = new TaskLedger(ws);
  const t = await tasks.create('P', '作業', '實作');
  const store = new ChatStore(ws);
  const events: SseEvent[] = [];
  const runner = new ChatRunner({
    ws,
    store,
    tasks,
    roles: async () => ROLES,
    providers: { mock: new MockCliProvider(5) },
    limits,
    prepareCwd: async (p) => ws.projectDir(p),
  });
  // 事件驅動等待：每次 runner 發事件就重新檢查條件，不用計時器
  const waiters: Array<{ pred: () => boolean; resolve: () => void }> = [];
  runner.on('event', (_p: string, _t: string, ev: SseEvent) => {
    events.push(ev);
    for (const w of [...waiters]) {
      if (w.pred()) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  });
  const waitFor = (pred: () => boolean): Promise<void> => {
    if (pred()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ pred, resolve });
    return promise;
  };
  const doneCount = () => events.filter((e) => e.event === 'done').length;
  return { tasks, store, runner, events, task: t.id, waitFor, doneCount };
}

test('流程範例 1：送出 → log(user) → delta… → log(assistant) → done；JSONL 恰兩行', () =>
  withTmpWorkspace(async (ws) => {
    const s = await setup(ws);
    const r = await s.runner.send('P', s.task, '你好', {});
    assert.equal(r.queued, false);
    await s.waitFor(() => s.doneCount() === 1);
    const kinds = s.events.map((e) => e.event);
    assert.equal(kinds[0], 'log');
    assert.equal(kinds[1], 'task'); // 未開始 → 進行中
    assert.ok(kinds.includes('delta'));
    assert.equal(kinds.at(-2), 'log');
    assert.equal(kinds.at(-1), 'done');
    const log = await s.store.readLog('P', s.task);
    assert.equal(log.length, 2);
    assert.equal(log[0]?.role, 'user');
    assert.equal(log[1]?.role, 'assistant');
    assert.match(log[1]?.text ?? '', /^已收到：你好/);
    const raw = await fs.readFile(ws.chatFile('P', s.task, 'jsonl'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2);
    const meta = await s.store.readMeta('P', s.task);
    assert.match(meta.sessions['mock'] ?? '', /^mock-/);
    assert.equal(meta.seen['mock'], log[1]?.request);
    assert.equal((await s.tasks.get('P', s.task)).state, '進行中');
  }));

test('續聊沿用 session；換 CLI 時帶交接包', () =>
  withTmpWorkspace(async (ws) => {
    const s = await setup(ws);
    await s.runner.send('P', s.task, '第一句', {});
    await s.waitFor(() => s.doneCount() === 1);
    await s.runner.send('P', s.task, '第二句', {});
    await s.waitFor(() => s.doneCount() === 2);
    const log = await s.store.readLog('P', s.task);
    assert.match(log[3]?.text ?? '', /續聊 mock-/);
    // 第二個 provider 沒看過前面的對話 → 提示含交接包；mock 回覆的是最後一行＝使用者指示
    const seen: string[] = [];
    const spy = new MockCliProvider(5);
    const origSend = spy.send.bind(spy);
    spy.send = (opts, cb) => {
      seen.push(opts.prompt);
      return origSend(opts, cb);
    };
    const runner2 = new ChatRunner({
      ws,
      store: s.store,
      tasks: s.tasks,
      roles: async () => ROLES,
      providers: { mock: new MockCliProvider(5), other: spy },
      limits: { concurrentRuns: 2, queueLength: 3, handoffChars: 24_000 },
      prepareCwd: async (p) => ws.projectDir(p),
    });
    const done2 = Promise.withResolvers<void>();
    runner2.on('event', (_p: string, _t: string, ev: SseEvent) => ev.event === 'done' && done2.resolve());
    await runner2.send('P', s.task, '第三句', { cli: 'other' });
    await done2.promise;
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? '', /<previous_conversation>/);
    assert.match(seen[0] ?? '', /第一句[\s\S]*第二句/);
    assert.match(seen[0] ?? '', /你是 other/);
    assert.ok((seen[0] ?? '').endsWith('第三句'));
  }));

test('流程範例 2：執行中送出 → 入隊；停止 → 標記 cancelled；本輪 done 後出隊執行；隊列清空', () =>
  withTmpWorkspace(async (ws) => {
    const s = await setup(ws);
    await s.runner.send('P', s.task, '[slow] 慢慢來', {});
    const q = await s.runner.send('P', s.task, '下一句', {});
    assert.equal(q.queued, true);
    assert.equal((await s.store.readQueue('P', s.task)).length, 1);
    assert.ok(s.events.some((e) => e.event === 'queue' && e.data.length === 1));
    await s.waitFor(() => s.events.some((e) => e.event === 'delta'));
    assert.equal(s.runner.stop('P', s.task), true);
    await s.waitFor(() => s.doneCount() === 2);
    const log = await s.store.readLog('P', s.task);
    assert.equal(log.length, 4);
    assert.equal(log[1]?.cancelled, true);
    assert.ok((log[1]?.text ?? '').length < '已收到：[slow] 慢慢來'.length);
    assert.equal(log[2]?.text, '下一句');
    assert.equal(log[3]?.cancelled, undefined);
    assert.deepEqual(await s.store.readQueue('P', s.task), []);
    assert.equal(s.runner.stop('P', s.task), false);
  }));

test('失敗 fail-closed：error 列、error 事件、已收部分標記中斷', () =>
  withTmpWorkspace(async (ws) => {
    const s = await setup(ws);
    await s.runner.send('P', s.task, '[fail] 會壞', {});
    await s.waitFor(() => s.doneCount() === 1);
    const log = await s.store.readLog('P', s.task);
    assert.equal(log.at(-1)?.role, 'error');
    assert.equal(log.at(-2)?.interrupted, true);
    assert.ok(s.events.some((e) => e.event === 'error' && e.data.code === 'cli_failed'));
  }));

test('隊列上限、移除排隊、同時執行上限', () =>
  withTmpWorkspace(async (ws) => {
    const s = await setup(ws, { concurrentRuns: 1, queueLength: 1, handoffChars: 1000 });
    await s.runner.send('P', s.task, '[slow] a', {});
    const q = await s.runner.send('P', s.task, 'b', {});
    await assert.rejects(s.runner.send('P', s.task, 'c', {}), (e: unknown) => e instanceof AppError && e.code === 'unavailable');
    const t2 = await s.tasks.create('P', '另一件', '實作');
    await assert.rejects(s.runner.send('P', t2.id, 'x', {}), (e: unknown) => e instanceof AppError && e.code === 'unavailable');
    await s.runner.removeQueued('P', s.task, q.request);
    assert.deepEqual(await s.store.readQueue('P', s.task), []);
    await assert.rejects(s.runner.removeQueued('P', s.task, q.request), (e: unknown) => e instanceof AppError && e.code === 'not_found');
    s.runner.stop('P', s.task);
    await s.waitFor(() => s.doneCount() === 1);
  }));

test('role 為人或 CLI 不存在時拒絕', () =>
  withTmpWorkspace(async (ws) => {
    const s = await setup(ws);
    await assert.rejects(s.runner.send('P', s.task, 'x', { cli: 'claude' }), (e: unknown) => e instanceof AppError && e.code === 'bad_request');
  }));

test('prepareCwd 失敗：發 error／done 並釋放執行槽，之後可再送', () =>
  withTmpWorkspace(async (ws) => {
    const s = await setup(ws);
    let fail = true;
    const runner = new ChatRunner({
      ws,
      store: s.store,
      tasks: s.tasks,
      roles: async () => ROLES,
      providers: { mock: new MockCliProvider(5) },
      limits: { concurrentRuns: 2, queueLength: 3, handoffChars: 1000 },
      prepareCwd: async (p) => {
        if (fail) throw new Error('git 壞了');
        return ws.projectDir(p);
      },
    });
    const dones: string[] = [];
    const waitDone = () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      runner.once('event', function handler(_p: string, _t: string, ev: SseEvent) {
        if (ev.event === 'done') {
          dones.push(ev.data.request);
          resolve();
        } else runner.once('event', handler);
      });
      return promise;
    };
    const d1 = waitDone();
    await runner.send('P', s.task, 'x', {});
    await d1;
    assert.equal(runner.isRunning('P', s.task), false);
    fail = false;
    const d2 = waitDone();
    const r = await runner.send('P', s.task, 'y', {});
    assert.equal(r.queued, false);
    await d2;
    const log = await s.store.readLog('P', s.task);
    assert.equal(log[1]?.role, 'error');
    assert.match(log.at(-1)?.text ?? '', /^已收到：y/);
  }));

test('同時入隊不會互相蓋掉', () =>
  withTmpWorkspace(async (ws) => {
    const s = await setup(ws, { concurrentRuns: 2, queueLength: 10, handoffChars: 1000 });
    await s.runner.send('P', s.task, '[slow] a', {});
    await Promise.all(['b', 'c', 'd', 'e'].map((t) => s.runner.send('P', s.task, t, {})));
    const queue = await s.store.readQueue('P', s.task);
    assert.deepEqual(queue.map((q) => q.text).sort(), ['b', 'c', 'd', 'e']);
    s.runner.stop('P', s.task);
    await s.waitFor(() => s.doneCount() === 5);
    assert.deepEqual(await s.store.readQueue('P', s.task), []);
  }));

test('unseenRows：以 request 標記取未讀列，舊版行數標記相容', () => {
  const rows = ['a', 'b', 'c', 'd'].map((r) => ({ at: '', role: 'user' as const, text: r, cli: 'x', request: r }));
  assert.deepEqual(unseenRows(rows, { sessions: {}, seen: {} }, 'x').map((r) => r.text), ['a', 'b', 'c', 'd']);
  assert.deepEqual(unseenRows(rows, { sessions: {}, seen: { x: 'b' } }, 'x').map((r) => r.text), ['c', 'd']);
  assert.deepEqual(unseenRows(rows, { sessions: {}, seen: { x: 3 } }, 'x').map((r) => r.text), ['d']);
  assert.deepEqual(unseenRows(rows, { sessions: {}, seen: { x: 'gone' } }, 'x').map((r) => r.text), ['a', 'b', 'c', 'd']);
});
