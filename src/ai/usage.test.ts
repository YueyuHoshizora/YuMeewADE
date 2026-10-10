import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliProvider } from '../cli/provider.ts';
import type { UsageState } from '../shared/types.ts';
import { UsageBoard } from './usage.ts';

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
    tokensPerSecond: 0,
    ais: [
      { ai: 'claude', windows: [{ label: '5h', usedPercent: 5, resetsAt: null }], limited: false, quotaAt: '2026-10-10T10:01:00Z' },
      { ai: 'codex', windows: [{ label: '5h', usedPercent: 40, resetsAt: null }], limited: false, quotaAt: '2026-10-10T10:00:00Z' },
    ],
  });
});

test('tok/s 為最近 4 秒內所有對話的輸出合計，跨度樣本只算落在窗口內的部分，閒置後歸零', () => {
  let clock = 10_000;
  const board = new UsageBoard(() => {}, () => clock);
  try {
    // 兩個並行對話各自串流。
    board.record('claude', { type: 'tokens', count: 30 });
    clock = 10_500;
    board.record('claude', { type: 'tokens', count: 50 });
    assert.equal(board.rateAt(11_000), 20);
    // 校正量 40 攤在過去 8 秒：窗口 [7500, 11500] 只涵蓋其中一半 = 20。
    clock = 11_500;
    board.record('claude', { type: 'tokens', count: 40, spanMs: 8000 });
    assert.equal(board.rateAt(11_500), 25);
    // 估算偏高的負校正不會讓速度變負。
    clock = 14_000;
    board.record('claude', { type: 'tokens', count: -100 });
    assert.equal(board.rateAt(14_000), 0);
    assert.equal(board.rateAt(30_000), 0);
  } finally {
    board.close();
  }
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
