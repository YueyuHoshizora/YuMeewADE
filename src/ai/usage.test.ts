import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliProvider } from '../cli/provider.ts';
import type { AiUsage } from '../shared/types.ts';
import { UsageBoard } from './usage.ts';

const quota = (at: string, used: number) => ({ type: 'quota' as const, windows: [{ label: '5h', usedPercent: used, resetsAt: null }], limited: false, at });

test('額度只前進不倒退，速度與額度各自更新且每次變更都推送完整清單', () => {
  const pushed: AiUsage[][] = [];
  const board = new UsageBoard(usage => pushed.push(usage));
  board.record('codex', quota('2026-10-10T10:00:00Z', 40));
  board.record('claude', { type: 'speed', tokensPerSecond: 80 }, new Date('2026-10-10T10:01:00Z'));
  // 並行回合晚到的舊資料不能把用量蓋回去。
  board.record('codex', quota('2026-10-10T09:00:00Z', 10));
  board.record('codex', { type: 'speed', tokensPerSecond: 30 }, new Date('2026-10-10T10:02:00Z'));
  assert.equal(pushed.length, 3);
  assert.deepEqual(board.list(), [
    { ai: 'claude', windows: [], limited: false, quotaAt: null, tokensPerSecond: 80, speedAt: '2026-10-10T10:01:00.000Z' },
    { ai: 'codex', windows: [{ label: '5h', usedPercent: 40, resetsAt: null }], limited: false, quotaAt: '2026-10-10T10:00:00Z', tokensPerSecond: 30, speedAt: '2026-10-10T10:02:00.000Z' },
  ]);
  assert.deepEqual(pushed.at(-1), board.list());
});

test('啟動載入只問有本機紀錄的 CLI，單一 CLI 讀取失敗不影響其他', async () => {
  const board = new UsageBoard(() => {});
  const base = { dangerous: false, available: async () => true, send: () => { throw new Error('unused'); } };
  await board.load({
    claude: { ...base, name: 'claude' },
    codex: { ...base, name: 'codex', quota: async () => quota('2026-10-10T10:00:00Z', 55) },
    broken: { ...base, name: 'broken', quota: async () => { throw new Error('EACCES'); } },
  } satisfies Record<string, CliProvider>);
  assert.deepEqual(board.list().map(entry => [entry.ai, entry.windows[0]?.usedPercent]), [['codex', 55]]);
});
