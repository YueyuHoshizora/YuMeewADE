import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliEvent, CliProvider } from '../cli/provider.ts';
import type { UsageState } from '../shared/types.ts';
import { UsageBoard } from './usage.ts';
import { createClaudeParser } from '../cli/claude.ts';
import { createCodexParser } from '../cli/codex.ts';
import { createGeminiParser } from '../cli/gemini.ts';

const quota = (at: string, used: number) => ({ type: 'quota' as const, windows: [{ label: '5h', usedPercent: used, resetsAt: null }], limited: false, at });

test('額度只前進不倒退，每次變更都推送完整快照', () => {
  const pushed: UsageState[] = [];
  const board = new UsageBoard(usage => pushed.push(usage));
  board.record('codex', quota('2026-10-10T10:00:00Z', 40));
  board.record('claude', quota('2026-10-10T10:01:00Z', 5));
  // 並行回合晚到的舊資料不能把用量蓋回去。
  board.record('codex', quota('2026-10-10T09:00:00Z', 10));
  assert.equal(pushed.length, 2);
  assert.deepEqual(board.snapshot(), {
    tokensPerSecond: null,
    ais: [
      { ai: 'claude', account: 'default', status: 'ready', windows: [{ label: '5h', usedPercent: 5, resetsAt: null }], limited: false, quotaAt: '2026-10-10T10:01:00Z' },
      { ai: 'codex', account: 'default', status: 'ready', windows: [{ label: '5h', usedPercent: 40, resetsAt: null }], limited: false, quotaAt: '2026-10-10T10:00:00Z' },
    ],
  });
});

test('回合中的額度事件不帶額外使用額度時保留上次的，新查詢則取代', () => {
  const board = new UsageBoard(() => {});
  try {
    const extra = (balance: number) => ({ unlimited: false, currency: 'USD', balance });
    board.record('codex', { ...quota('2026-10-10T10:00:00Z', 40), extraUsage: extra(5) });
    board.record('codex', quota('2026-10-10T10:05:00Z', 50));
    assert.deepEqual(board.snapshot().ais[0]?.extraUsage, extra(5));
    board.record('codex', { ...quota('2026-10-10T10:10:00Z', 50), extraUsage: extra(0) });
    assert.deepEqual(board.snapshot().ais[0]?.extraUsage, extra(0));
  } finally { board.close(); }
});

test('回合中的額度事件不帶重置券時保留帳號查詢的重置券，新查詢則取代', () => {
  const board = new UsageBoard(() => {});
  try {
    const credits = { availableCount: 1, credits: [{ title: 'Full reset', expiresAt: '2026-11-01T00:00:00.000Z' }] };
    board.record('codex', { ...quota('2026-10-10T10:00:00Z', 40), resetCredits: credits });
    board.record('codex', quota('2026-10-10T10:05:00Z', 50));
    assert.deepEqual(board.snapshot().ais[0]?.resetCredits, credits);
    board.record('codex', { ...quota('2026-10-10T10:10:00Z', 50), resetCredits: { availableCount: 0, credits: [] } });
    assert.deepEqual(board.snapshot().ais[0]?.resetCredits, { availableCount: 0, credits: [] });
  } finally { board.close(); }
});

test('實測冷啟動不除固定四秒；並行區間相加、累計回報取代，閒置／close 清空', () => {
  let clock = 1000;
  const pushed: UsageState[] = [];
  const board = new UsageBoard(usage => pushed.push(usage), () => clock);
  try {
    assert.equal(board.rateAt(clock), null);
    board.record('claude', { type: 'tokens', runId: 'a', count: 100, spanMs: 1000, at: clock });
    assert.equal(board.snapshot().tokensPerSecond, 100);
    board.record('codex', { type: 'tokens', runId: 'b', count: 50, spanMs: 1000, at: clock });
    assert.equal(board.snapshot().tokensPerSecond, 150);
    // 同一 run 的累計值取代舊量：200 + 50，而不是 100 + 200 + 50。
    clock = 2000;
    board.record('claude', { type: 'tokens', runId: 'a', count: 200, spanMs: 2000, at: clock });
    assert.equal(board.snapshot().tokensPerSecond, 125);
    for (const count of [-100, NaN, Infinity]) {
      board.record('claude', { type: 'tokens', runId: 'a', count, spanMs: 1000, at: clock });
    }
    for (const spanMs of [0, -1, NaN, Infinity]) {
      board.record('claude', { type: 'tokens', runId: 'a', count: 100, spanMs, at: clock });
    }
    assert.equal(board.rateAt(clock), 125);
    assert.equal(board.rateAt(6000), null);
    clock = 7000;
    board.record('codex', { type: 'tokens', runId: 'c', count: 0, spanMs: 1000, at: clock });
    assert.equal(board.snapshot().tokensPerSecond, 0);
    board.close();
    board.record('claude', { type: 'tokens', runId: 'd', count: 100, spanMs: 1000, at: clock });
    assert.equal(board.snapshot().tokensPerSecond, null);
    assert.equal(board.rateAt(clock), null);
    assert.ok(pushed.length >= 4);
  } finally { board.close(); }
});

test('先後回合加權平均，並行重疊只除區間聯集；區間中的閒置不算測量時間', () => {
  let clock = 2000;
  const board = new UsageBoard(() => {}, () => clock);
  try {
    board.record('claude', { type: 'tokens', runId: 'a', count: 100, spanMs: 1000, at: 1000 });
    board.record('codex', { type: 'tokens', runId: 'b', count: 200, spanMs: 1000, at: 2000 });
    assert.equal(board.rateAt(clock), 150);
    clock = 3000;
    board.record('claude', { type: 'tokens', runId: 'c', count: 200, spanMs: 2000, at: 3000 });
    assert.equal(board.rateAt(clock), 166.7);
    clock = 8000;
    board.record('codex', { type: 'tokens', runId: 'd', count: 100, spanMs: 1000, at: 6000 });
    board.record('codex', { type: 'tokens', runId: 'e', count: 100, spanMs: 1000, at: 8000 });
    assert.equal(board.rateAt(clock), 100);
  } finally { board.close(); }
});

test('連續 Claude 訊息保留近期樣本，與其他 CLI 加權且不重複計算最終總量', () => {
  let clock = 0;
  const board = new UsageBoard(() => {}, () => clock);
  const claude = createClaudeParser(ev => { if (ev.type === 'tokens') board.record('claude', ev); }, () => clock);
  const codex = createCodexParser(ev => { if (ev.type === 'tokens') board.record('codex', ev); }, () => clock);
  const event = (type: string, output?: number) => claude({ type: 'stream_event', event: { type, ...(output === undefined ? {} : { usage: { output_tokens: output } }) } });
  try {
    event('message_start');
    codex({ type: 'turn.started' });
    clock = 2000;
    event('message_delta', 100);
    codex({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 40 } });
    assert.equal(board.snapshot().tokensPerSecond, 70);
    event('message_stop');
    clock = 3000; event('message_start');
    clock = 4000; event('message_delta', 20);
    // 160 tokens / (2s + 1s), excluding the gap and counting overlap only once.
    assert.equal(board.snapshot().tokensPerSecond, 53.3);
    claude({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 120 } });
    assert.equal(board.snapshot().tokensPerSecond, 53.3);
    assert.equal(board.rateAt(6000), 20);
    assert.equal(board.rateAt(8000), null);
  } finally { board.close(); }
});

test('主訊息與子代理交錯輸出各自計時，結束子訊息不會停止主訊息量測', () => {
  let clock = 0;
  const board = new UsageBoard(() => {}, () => clock);
  const parse = createClaudeParser(ev => { if (ev.type === 'tokens') board.record('claude', ev); }, () => clock);
  const event = (type: string, output?: number, parent: string | null = null) => parse({ type: 'stream_event', parent_tool_use_id: parent, event: { type, ...(output === undefined ? {} : { usage: { output_tokens: output } }) } });
  try {
    event('message_start');
    clock = 500; event('message_start', undefined, 'agent');
    clock = 1000; event('message_delta', 100);
    assert.equal(board.snapshot().tokensPerSecond, 100);
    clock = 1500; event('message_delta', 50, 'agent');
    assert.equal(board.snapshot().tokensPerSecond, 100);
    event('message_stop', undefined, 'agent');
    clock = 2000; event('message_delta', 200);
    assert.equal(board.snapshot().tokensPerSecond, 125);
    event('message_stop');
    event('message_start', undefined, 'agent');
    clock = 2500; event('message_delta', 25, 'agent');
    assert.equal(board.snapshot().tokensPerSecond, 110);
  } finally { board.close(); }
});

test('Gemini 重複 step 不灌水或延長計時，修正用量取代且不同 step 才累加', () => {
  let clock = 0;
  const board = new UsageBoard(() => {}, () => clock);
  const events: CliEvent[] = [];
  const parse = createGeminiParser(ev => {
    events.push(ev);
    if (ev.type === 'tokens') board.record('gemini', ev);
  }, () => clock);
  const done = (index: number, input: number, output: number, cached: number) => parse({
    event: 'step_update', step_update: { step_index: index, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: input, output_tokens: output, cache_read_tokens: cached } },
  });
  try {
    clock = 1000; done(1, 10, 50, 2);
    clock = 1200; done(1, 10, 50, 2);
    assert.equal(board.snapshot().tokensPerSecond, 50);
    clock = 2000; done(1, 12, 60, 3);
    assert.equal(board.snapshot().tokensPerSecond, 30);
    clock = 2500; done(1, 20, 40, 5);
    assert.equal(board.snapshot().tokensPerSecond, 16);
    clock = 3000; done(3, 30, 30, 2);
    assert.equal(board.snapshot().tokensPerSecond, 23.3);
    parse({ event: 'result', result: { conversation_id: 'conv', status: 'SUCCESS', response: 'Done', usage: { input_tokens: 999, output_tokens: 999 } } });
    assert.deepEqual(events.filter(ev => ev.type === 'usage').at(-1), { type: 'usage', usage: { input: 50, output: 70, cached: 7 } });
    assert.equal(board.snapshot().tokensPerSecond, 23.3);
    assert.equal(board.rateAt(7000), null);
  } finally { board.close(); }
});

test('Gemini 缺少實際輸出計數或 step 身分時不假裝有 tok/s 量測', () => {
  let clock = 0;
  const board = new UsageBoard(() => {}, () => clock);
  const parse = createGeminiParser(ev => { if (ev.type === 'tokens') board.record('gemini', ev); }, () => clock);
  try {
    clock = 1000;
    for (const output of [undefined, NaN, Infinity, -1, 1.5]) {
      parse({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: output } } });
    }
    parse({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { output_tokens: 10 } } });
    assert.equal(board.snapshot().tokensPerSecond, null);
  } finally { board.close(); }
});


test('同一 AI 的並行 parser 有獨立 runId，不互相覆蓋或被文字估算抵銷', () => {
  let clock = 0;
  const board = new UsageBoard(() => {}, () => clock);
  const first = createClaudeParser(ev => { if (ev.type === 'tokens') board.record('claude', ev); }, () => clock);
  const second = createClaudeParser(ev => { if (ev.type === 'tokens') board.record('claude', ev); }, () => clock);
  try {
    for (const parser of [first, second]) parser({ type: 'stream_event', event: { type: 'message_start' } });
    clock = 1000;
    first({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', estimated_tokens: 10000 } } });
    first({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 10 } } });
    second({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } });
    assert.equal(board.snapshot().tokensPerSecond, 60);
  } finally { board.close(); }
});

test('啟動載入只問有額度介面的 CLI，單一 CLI 查詢失敗不影響其他', async () => {
  const board = new UsageBoard(() => {});
  const base = { dangerous: false, available: async () => true, send: () => { throw new Error('unused'); } };
  await board.load({
    mock: { ...base, name: 'mock' },
    codex: { ...base, name: 'codex', quota: async () => quota('2026-10-10T10:00:00Z', 55) },
    broken: { ...base, name: 'broken', quota: async () => { throw new Error('EACCES'); } },
  } satisfies Record<string, CliProvider>);
  assert.deepEqual(board.snapshot().ais.map(entry => [entry.ai, entry.account, entry.status, entry.windows[0]?.usedPercent]),
    [['broken', 'default', 'unavailable', undefined], ['codex', 'default', 'ready', 55]]);
  board.close();
});

test('a successful account query without cloud credits or extras clears the old ones instead of re-dating them', async () => {
  const board = new UsageBoard(() => {});
  const base = { dangerous: false, available: async () => true, send: () => { throw new Error('unused'); } };
  const cloudCredits = { balance: 1000, expiresAt: '2026-10-13T12:00:00.000Z' };
  let next: Extract<CliEvent, { type: 'quota' }> = { ...quota('2026-10-13T00:00:00Z', 10), cloudCredits, extraUsage: { unlimited: false, currency: 'USD', balance: 5 } };
  const providers = { claude: { ...base, name: 'claude', quota: async () => next } } satisfies Record<string, CliProvider>;
  try {
    await board.load(providers);
    assert.deepEqual(board.snapshot().ais[0]?.cloudCredits, cloudCredits);
    next = quota('2026-10-13T00:01:00Z', 20);
    await board.load(providers);
    const entry = board.snapshot().ais[0]!;
    assert.deepEqual([entry.quotaAt, entry.cloudCredits, entry.extraUsage], ['2026-10-13T00:01:00Z', undefined, undefined]);
  } finally { board.close(); }
});

test('poll：啟動查一次並定期重查，額度隨 CLI 回報更新、關閉後不再查', async () => {
  const pushed: UsageState[] = [];
  const board = new UsageBoard(usage => pushed.push(usage));
  let used = 10;
  let calls = 0;
  const provider: CliProvider = {
    name: 'codex', dangerous: false, available: async () => true, send: () => { throw new Error('unused'); },
    quota: async () => { calls++; used += 10; return quota(new Date().toISOString(), used); },
  };
  await board.poll({ codex: provider }, 20);
  assert.equal(board.snapshot().ais[0]?.windows[0]?.usedPercent, 20);
  await new Promise(resolve => setTimeout(resolve, 120));
  board.close();
  const after = calls;
  assert.ok(after >= 3, `重查次數 ${after}`);
  assert.equal(board.snapshot().ais[0]?.windows[0]?.usedPercent, used);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, after);
});

test('額度帳戶隔離／singleflight／失敗狀態；刪除帳戶與 close 丟棄晚到回應', async () => {
  const pending = new Map<string, {
    promise: Promise<Extract<CliEvent, { type: 'quota' }> | null>;
    resolve: (value: Extract<CliEvent, { type: 'quota' }> | null) => void;
    reject: (reason: unknown) => void;
  }>();
  const calls: string[] = [];
  const provider: CliProvider = {
    name: 'claude', dangerous: false, available: async () => true, send: () => { throw new Error('unused'); },
    quota: async configDir => {
      const key = configDir ?? 'default';
      calls.push(key);
      const deferred = Promise.withResolvers<Extract<CliEvent, { type: 'quota' }> | null>();
      pending.set(key, deferred);
      return deferred.promise;
    },
  };
  const board = new UsageBoard(() => {});
  const providers = { claude: provider };
  const accounts = { claude: [{ id: 'extra', name: 'Extra', configDir: '/extra' }] };
  const first = board.load(providers, accounts);
  const second = board.load(providers, accounts);
  assert.deepEqual(calls, ['default', '/extra']);
  pending.get('default')!.resolve(quota('2026-10-10T10:00:00Z', 10));
  pending.get('/extra')!.resolve(quota('2026-10-10T10:00:00Z', 80));
  await Promise.all([first, second]);
  assert.deepEqual(board.snapshot().ais.map(item => [item.account, item.windows[0]?.usedPercent]), [['default', 10], ['extra', 80]]);
  const failure = board.load(providers, accounts);
  pending.get('default')!.resolve(null);
  pending.get('/extra')!.reject(new Error('private credentials'));
  await failure;
  assert.deepEqual(board.snapshot().ais.map(item => [item.account, item.status, item.windows[0]?.usedPercent]), [['default', 'unavailable', 10], ['extra', 'unavailable', 80]]);
  const reload = board.load(providers, accounts);
  const prune = board.load(providers, {});
  pending.get('default')!.resolve(quota('2026-10-10T11:00:00Z', 20));
  pending.get('/extra')!.resolve(quota('2026-10-10T11:00:00Z', 90));
  await Promise.all([reload, prune]);
  assert.deepEqual(board.snapshot().ais.map(item => item.account), ['default']);
  const late = board.load(providers, accounts);
  board.close();
  pending.get('default')!.resolve(quota('2026-10-10T12:00:00Z', 30));
  pending.get('/extra')!.resolve(quota('2026-10-10T12:00:00Z', 100));
  await late;
  assert.equal(board.snapshot().ais[0]?.windows[0]?.usedPercent, 20);
  assert.equal(board.snapshot().ais.length, 1);
});
