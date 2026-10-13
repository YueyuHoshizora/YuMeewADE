import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { MockCliProvider } from '../cli/mock.ts';
import type { ChatEvent, ChatHistory, ChatRow, Task } from '../shared/types.ts';
import { startTestServer } from '../testing/server.ts';

interface CollectedStream {
  events: ChatEvent[];
  waitFor(predicate: () => boolean): Promise<void>;
  close(): Promise<void>;
}
async function collect(response: Response): Promise<CollectedStream> {
  const reader = response.body!.getReader();
  const events: ChatEvent[] = [];
  const decoder = new TextDecoder();
  let text = '';
  let changed = Promise.withResolvers<void>();
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
        let split: number;
        while ((split = text.indexOf('\n\n')) >= 0) {
          const frame = text.slice(0, split); text = text.slice(split + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) } as ChatEvent);
        }
        changed.resolve(); changed = Promise.withResolvers<void>();
      }
    } catch { /* Cancellation ends the reader. */ }
  })();
  return {
    events,
    waitFor: async predicate => { while (!predicate()) await changed.promise; },
    close: async () => { await reader.cancel(); await pump; },
  };
}
// Exercise the real view's row branch without mounting unrelated browser controls.
async function rowConsumer() {
  const source = await fs.readFile(new URL('../ui/views/task.ts', import.meta.url), 'utf8');
  const branch = source.split("      case 'row':")[1]!.split("      case 'queue':")[0]!;
  return new Function('event', 'history', 'rows', 'displayed', `let busy = null; let partial = ''; let transientIndex = -1; const removeLive = () => {}; const appendWindowRow = (entry, index) => { displayed?.push(index); }; const renderQuestion = () => {}; const follow = () => {}; switch (event.event) { case 'row': ${branch} }`) as (event: ChatEvent, history: { start: number }, rows: ChatRow[], displayed?: number[]) => void;
}

for (const race of ['LOSS', 'DUPLICATE'] as const) {
  test(`SSE reconnect ${race}: snapshot/live boundary preserves one reply and idle`, { timeout: 10000 }, async () => {
    const s = await startTestServer('', { providers: { codex: new MockCliProvider({ chunkMs: 30, text: 'final reply' }) } });
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    let stream: CollectedStream | undefined;
    try {
      await s.api('POST', '/api/project/new', { name: 'P' });
      const task = (await s.api('POST', '/api/task/new', { project: 'P', title: 'T', workspace: 'direct' })).json as Task;
      if (race === 'DUPLICATE') {
        const append = s.app.store.append.bind(s.app.store);
        s.app.store.append = async (p, t, row) => {
          const position = await append(p, t, row);
          if (row.role === 'assistant') { entered.resolve(); await release.promise; }
          return position;
        };
      }
      assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task: task.id, text: 'hello' })).status, 200);
      let response: Promise<Response>;
      if (race === 'LOSS') {
        const readQueue = s.app.store.readQueue.bind(s.app.store); let first = true;
        s.app.store.readQueue = async (p, t) => {
          if (first) { first = false; entered.resolve(); await release.promise; }
          return readQueue(p, t);
        };
        response = fetch(`${s.base}/api/chat/stream?project=P&task=${task.id}`);
        await entered.promise; await s.app.runner.whenIdle(); release.resolve();
      } else {
        await entered.promise;
        response = fetch(`${s.base}/api/chat/stream?project=P&task=${task.id}`);
      }
      stream = await collect(await response);
      await stream.waitFor(() => stream!.events.some(event => event.event === 'snapshot'));
      release.resolve(); await s.app.runner.whenIdle();
      if (race === 'DUPLICATE') await stream.waitFor(() => stream!.events.some(event => event.event === 'idle'));
      const snapshot = stream.events.find(event => event.event === 'snapshot');
      assert.ok(snapshot?.event === 'snapshot');
      assert.equal(stream.events[0]?.event, 'snapshot');
      if (race === 'LOSS') {
        assert.equal(snapshot.data.busy, null, 'LOSS: captured state must reflect the completed turn');
        if (!snapshot.data.rows.some(row => row.role === 'assistant')) {
          await stream.waitFor(() => stream!.events.some(event => event.event === 'row' && event.data.role === 'assistant'));
        }
      }
      const rows = [...snapshot.data.rows]; let busy = snapshot.data.busy;
      const receiveRow = await rowConsumer();
      for (const event of stream.events.slice(1)) {
        if (event.event === 'row') receiveRow(event, { start: snapshot.data.start }, rows);
        if (event.event === 'busy') busy = event.data;
        if (event.event === 'idle' && busy?.request === event.data.request) busy = null;
      }
      assert.equal(rows.filter(row => row.role === 'assistant').length, 1, `${race}: assistant reply must appear exactly once`);
      assert.equal(busy, null, `${race}: client must not remain busy`);
      const persisted = await s.app.store.readLog('P', task.id);
      assert.equal(snapshot.data.start + rows.length, persisted.length, 'absolute history end must not drift');
      const history = await s.api('GET', `/api/chat/history?project=P&task=${task.id}&before=${snapshot.data.start + rows.length}`);
      const page = history.json as ChatHistory;
      assert.deepEqual(page.rows.map(row => row.role), rows.map(row => row.role));
    } finally { release.resolve(); await stream?.close(); await s.close(); }
  });
}

test('position deduplication retains different tool rows with the same request', async () => {
  const receiveRow = await rowConsumer();
  const rows: ChatRow[] = [];
  const first = { event: 'row', data: { position: 7, role: 'event', at: 'now', request: 'same', tool: true, text: 'Read a' } } as const;
  const second = { event: 'row', data: { ...first.data, position: 8, text: 'Read b' } } as const;
  receiveRow(first, { start: 7 }, rows); receiveRow(first, { start: 7 }, rows); receiveRow(second, { start: 7 }, rows);
  assert.deepEqual(rows.map(row => row.text), ['Read a', 'Read b']);
});

test('snapshot buffering includes rows published outside the chat runner', { timeout: 10000 }, async () => {
  const s = await startTestServer();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let stream: CollectedStream | undefined;
  try {
    await s.api('POST', '/api/project/new', { name: 'P' });
    const task = (await s.api('POST', '/api/task/new', { project: 'P', title: 'T', workspace: 'direct' })).json as Task;
    const readQueue = s.app.store.readQueue.bind(s.app.store);
    s.app.store.readQueue = async (p, t) => { entered.resolve(); await release.promise; return readQueue(p, t); };
    const response = fetch(`${s.base}/api/chat/stream?project=P&task=${task.id}`);
    await entered.promise;
    const row: ChatRow = { role: 'event', at: 'now', text: 'review result', request: 'review' };
    const position = await s.app.store.append('P', task.id, row);
    s.app.sse.publish(`P\0${task.id}`, { event: 'row', data: { ...row, position } });
    release.resolve(); stream = await collect(await response);
    await stream.waitFor(() => stream!.events.some(event => event.event === 'snapshot'));
    // This later frame is an ordering barrier, not a guessed network drain delay.
    s.app.sse.publish(`P\0${task.id}`, { event: 'idle', data: { request: 'barrier' } });
    await stream.waitFor(() => stream!.events.some(event => event.event === 'idle' && event.data.request === 'barrier'));
    const snapshot = stream.events[0];
    assert.ok(snapshot?.event === 'snapshot');
    const rows = [...snapshot.data.rows];
    const receiveRow = await rowConsumer();
    for (const event of stream.events.slice(1)) if (event.event === 'row') receiveRow(event, { start: snapshot.data.start }, rows);
    assert.deepEqual(rows.map(row => row.text), ['review result']);
    assert.equal(s.app.sse.size, 1);
  } finally { release.resolve(); await stream?.close(); await s.close(); }
});

test('an unpersisted error reply is displayed without advancing the history end', async () => {
  const receiveRow = await rowConsumer();
  const rows: ChatRow[] = []; const displayed: number[] = [];
  const row: ChatRow = { role: 'assistant', at: 'now', ai: 'codex', text: 'partial', request: 'failed', error: 'internal', ms: 1 };
  receiveRow({ event: 'row', data: row }, { start: 3 }, rows, displayed);
  assert.deepEqual(displayed, [-1]);
  assert.equal(rows.length, 0);
  receiveRow({ event: 'row', data: { ...row, position: 3 } }, { start: 3 }, rows, displayed);
  assert.deepEqual(displayed, [-1, 3]);
  assert.equal(rows.length, 1);
});
