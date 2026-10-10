import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliProvider } from '../cli/provider.ts';
import type { UsageState } from '../shared/types.ts';
import { UsageBoard } from './usage.ts';
import { createClaudeParser } from '../cli/claude.ts';
import { createCodexParser } from '../cli/codex.ts';

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
      { ai: 'claude', windows: [{ label: '5h', usedPercent: 5, resetsAt: null }], limited: false, quotaAt: '2026-10-10T10:01:00Z' },
      { ai: 'codex', windows: [{ label: '5h', usedPercent: 40, resetsAt: null }], limited: false, quotaAt: '2026-10-10T10:00:00Z' },
    ],
  });
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

test('parser → UsageBoard：Claude 與 Codex 真實用量隔離，下一則訊息取代舊樣本、不估算部分輸出', () => {
  let clock = 0;
  const board = new UsageBoard(() => {}, () => clock);
  const claude = createClaudeParser(ev => { if (ev.type === 'tokens') board.record('claude', ev); }, () => clock);
  const codex = createCodexParser(ev => { if (ev.type === 'tokens') board.record('codex', ev); }, () => clock);
  try {
    claude({ type: 'stream_event', event: { type: 'message_start' } });
    codex({ type: 'turn.started' });
    clock = 1000;
    claude({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcdefgh' } } });
    assert.equal(board.rateAt(clock), null);
    clock = 2000;
    claude({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 100 } } });
    codex({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 40 } });
    assert.equal(board.snapshot().tokensPerSecond, 70);
    claude({ type: 'stream_event', event: { type: 'message_stop' } });
    clock = 3000;
    claude({ type: 'stream_event', event: { type: 'message_start' } });
    clock = 4000;
    claude({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } });
    assert.equal(board.snapshot().tokensPerSecond, 20);
    // 結果中的總量是另一個彙總，不得再加入 message 用量。
    claude({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 120 } });
    assert.equal(board.snapshot().tokensPerSecond, 20);
    assert.equal(board.rateAt(8000), null);
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

test('啟動載入只問有本機紀錄的 CLI，單一 CLI 讀取失敗不影響其他', async () => {
  const board = new UsageBoard(() => {});
  const base = { dangerous: false, available: async () => true, send: () => { throw new Error('unused'); } };
  await board.load({
    claude: { ...base, name: 'claude' },
    codex: { ...base, name: 'codex', quota: async () => quota('2026-10-10T10:00:00Z', 55) },
    broken: { ...base, name: 'broken', quota: async () => { throw new Error('EACCES'); } },
  } satisfies Record<string, CliProvider>);
  assert.deepEqual(board.snapshot().ais.map(entry => [entry.ai, entry.windows[0]?.usedPercent]), [['codex', 55]]);
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
