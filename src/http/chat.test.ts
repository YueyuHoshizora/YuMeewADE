import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import type { ChatRow, QueueItem, RunState, Task } from '../shared/types.ts';
import { startTestServer, type TestServer } from '../testing/server.ts';

interface Received {
  event: string;
  data: unknown;
}

interface ReadySnapshot {
  running: RunState | null;
  partial: string;
  queue: QueueItem[];
  task: Task | null;
}

function requestOf(ev: Received): string | undefined {
  const d = ev.data;
  if (d && typeof d === 'object' && 'request' in d && typeof d.request === 'string') return d.request;
  return undefined;
}

/** 讀 SSE 直到 until 回 true（含該事件）；回所有事件。 */
async function readStream(s: TestServer, project: string, task: string, until: (ev: Received) => boolean, signal?: AbortSignal): Promise<Received[]> {
  const res = await fetch(`${s.base}/api/chat/stream?project=${encodeURIComponent(project)}&task=${task}`, signal ? { signal } : {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const out: Received[] = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (!ev || data === undefined) continue;
      const rec: Received = { event: ev, data: JSON.parse(data) as unknown };
      out.push(rec);
      if (until(rec)) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}

async function prep(s: TestServer): Promise<string> {
  await s.api('POST', '/api/projects', { name: 'P' });
  await fs.writeFile(s.app.ws.rolesFile, 'roles:\n  實作: { main: [mock, default, high], job: 寫碼 }\n');
  const created = (await s.api('POST', '/api/tasks', { project: 'P', title: 'T', role: '實作' })).json as Task;
  return created.id;
}

test('流程範例 1（HTTP）：send → SSE log/delta/log/done → log 兩筆', async () => {
  const s = await startTestServer();
  try {
    const task = await prep(s);
    const streaming = readStream(s, 'P', task, (ev) => ev.event === 'done');
    const sent = await s.api('POST', '/api/chat/send', { project: 'P', task, text: '哈囉' });
    assert.equal(sent.status, 200);
    const events = await streaming;
    assert.equal(events[0]?.event, 'ready');
    const kinds = events.map((e) => e.event);
    assert.equal(kinds.filter((k) => k === 'log').length, 2);
    assert.ok(kinds.includes('delta'));
    assert.equal(kinds.at(-1), 'done');
    const log = (await s.api('GET', `/api/chat/log?project=P&task=${task}`)).json as ChatRow[];
    assert.equal(log.length, 2);
    assert.equal(log[1]?.role, 'assistant');
  } finally {
    await s.close();
  }
});

test('流程範例 2（HTTP）：執行中 send 入隊 → stop → 出隊執行 → 隊列清空；斷線重連 ready 補狀態', async () => {
  const s = await startTestServer();
  try {
    const task = await prep(s);
    const first = readStream(s, 'P', task, (ev) => ev.event === 'delta');
    await s.api('POST', '/api/chat/send', { project: 'P', task, text: '[slow] 慢' });
    const queued = (await s.api('POST', '/api/chat/send', { project: 'P', task, text: '下一句' })).json as { request: string; queued: boolean };
    assert.equal(queued.queued, true);
    await first; // 已開始串流；reader 取消＝模擬斷線
    // 重連：ready 要帶 running 與 queue；接著讀到排隊那筆的 done
    const second = readStream(s, 'P', task, (ev) => ev.event === 'done' && requestOf(ev) === queued.request);
    const stop = await s.api('POST', '/api/chat/stop', { project: 'P', task });
    assert.deepEqual(stop.json, { stopped: true });
    const events = await second;
    assert.equal(events[0]?.event, 'ready');
    const ready = events[0]?.data as ReadySnapshot;
    assert.ok(ready.running !== null);
    assert.equal(ready.queue.length, 1);
    assert.equal(ready.task?.state, '進行中');
    assert.ok(events.some((e) => e.event === 'queue' && Array.isArray(e.data) && e.data.length === 0));
    const log = (await s.api('GET', `/api/chat/log?project=P&task=${task}`)).json as ChatRow[];
    assert.equal(log.length, 4);
    assert.equal(log[1]?.cancelled, true);
    assert.equal(log[3]?.role, 'assistant');
    assert.equal(log[3]?.cancelled, undefined);
    assert.deepEqual(await s.app.store.readQueue('P', task), []);
    assert.deepEqual((await s.api('POST', '/api/chat/stop', { project: 'P', task })).json, { stopped: false });
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task, text: '' })).status, 400);
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task, text: 'x', cli: 'claude' })).status, 400);
  } finally {
    await s.close();
  }
});

test('頻率限制與 SSE 連線上限', async () => {
  const s = await startTestServer('limits:\n  sendPerMinute: 2\n  sseConnections: 1\n');
  try {
    const task = await prep(s);
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task, text: 'a' })).status, 200);
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task, text: 'b' })).status, 200);
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task, text: 'c' })).status, 429);
    const ac = new AbortController();
    const held = Promise.withResolvers<void>();
    const hold = readStream(
      s,
      'P',
      task,
      (ev) => {
        if (ev.event === 'ready') held.resolve();
        return false;
      },
      ac.signal,
    ).catch(() => []);
    await held.promise;
    // 第一條還開著時第二條應被拒
    const res = await fetch(`${s.base}/api/chat/stream?project=P&task=${task}`);
    assert.equal(res.status, 503);
    ac.abort();
    await hold;
  } finally {
    await s.close();
  }
});
