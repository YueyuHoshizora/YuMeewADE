import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiUsage, UsageState } from '../../shared/types.ts';
import { quotaAlerts } from './quota-alert.ts';

const FUTURE = '2026-10-10T15:00:00Z';
const usage = (percent: number, extra: Partial<AiUsage> = {}): AiUsage => ({
  ai: 'claude', account: 'default', status: 'ready', windows: [{ label: '5h', usedPercent: percent, resetsAt: FUTURE }],
  limited: false, quotaAt: '2026-10-10T12:00:00Z', ...extra,
});
const state = (...ais: AiUsage[]): UsageState => ({ ais, tokensPerSecond: null });
const fresh = (percent: number, extra: Partial<AiUsage> = {}) => usage(percent, { quotaAt: '2026-10-10T12:05:00Z', ...extra });

test('成功的新查詢用滿或恢復才通知，相同、較舊與初次資料不通知', () => {
  assert.deepEqual(quotaAlerts(state(usage(80)), state(fresh(100))), [{ ai: 'claude', account: 'default', kind: 'full', windows: ['5h'], resetsAt: FUTURE }]);
  assert.deepEqual(quotaAlerts(state(usage(100)), state(fresh(20))), [{ ai: 'claude', account: 'default', kind: 'recovered', windows: [], resetsAt: null }]);
  for (const next of [fresh(100), usage(20), fresh(20, { quotaAt: '2026-10-10T11:00:00Z' }), fresh(20, { status: 'unavailable' }), fresh(20, { quotaAt: null })]) {
    assert.deepEqual(quotaAlerts(state(usage(100)), state(next)), []);
  }
  assert.deepEqual(quotaAlerts(state(), state(fresh(100))), []);
  assert.deepEqual(quotaAlerts(state(usage(20)), state(fresh(95))), []);
});

test('重置時間過了不假裝恢復，查詢失敗後仍可依新資料辨識恢復', () => {
  const expired = usage(100, { windows: [{ label: '5h', usedPercent: 100, resetsAt: '2026-10-10T11:00:00Z' }] });
  assert.deepEqual(quotaAlerts(state(expired), state({ ...expired, quotaAt: '2026-10-10T12:05:00Z' })), []);
  assert.equal(quotaAlerts(state({ ...expired, status: 'unavailable' }), state(fresh(0)))[0]?.kind, 'recovered');
  assert.equal(quotaAlerts(state(usage(50)), state(fresh(50, { limited: true })))[0]?.kind, 'full');
});

test('帳戶互相隔離，多個滿窗口全部解除前不能聲稱恢復', () => {
  const two = fresh(100, { account: 'work', windows: [{ label: '7d', usedPercent: 100, resetsAt: '2026-10-14T00:00:00Z' }, { label: '5h', usedPercent: 100, resetsAt: FUTURE }] });
  const before = state(usage(100), usage(10, { account: 'work' }));
  assert.deepEqual(quotaAlerts(before, state(fresh(100), two)), [{ ai: 'claude', account: 'work', kind: 'full', windows: ['7d', '5h'], resetsAt: '2026-10-14T00:00:00Z' }]);
  assert.deepEqual(quotaAlerts(state(usage(100)), state(fresh(20, { account: 'new' }))), []);
  const partial = { ...two, quotaAt: '2026-10-10T12:10:00Z', windows: [two.windows[0]!, { label: '5h', usedPercent: 0, resetsAt: FUTURE }] };
  assert.deepEqual(quotaAlerts(state(two), state(partial)), []);
});
