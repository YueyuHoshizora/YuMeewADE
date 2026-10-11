import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiUsage, UsageState } from '../../shared/types.ts';
import { quotaAlerts, quotaCountdowns, type QuotaAlert } from './quota-alert.ts';

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
  assert.deepEqual(quotaAlerts(state(usage(20)), state(fresh(30))), []);
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

test('Grok paid spending limits do not produce alerts or suppress included-quota recovery', () => {
  const windows = (included: number, paid: number) => [
    { label: '7d credits', usedPercent: included, resetsAt: FUTURE },
    { label: 'on-demand', usedPercent: paid, resetsAt: FUTURE },
  ];
  const before = usage(20, { ai: 'grok', windows: windows(20, 99) });
  const paidFull = fresh(20, { ai: 'grok', windows: windows(20, 100) });
  assert.deepEqual(quotaAlerts(state(before), state(paidFull)), []);
  const includedFull = fresh(100, { ai: 'grok', windows: windows(100, 100) });
  assert.deepEqual(quotaAlerts(state(before), state(includedFull)), [
    { ai: 'grok', account: 'default', kind: 'full', windows: ['7d credits'], resetsAt: FUTURE },
  ]);
  const recovered = fresh(0, { ai: 'grok', windows: windows(0, 100), quotaAt: '2026-10-10T12:10:00Z' });
  assert.deepEqual(quotaAlerts(state(includedFull), state(recovered)), [
    { ai: 'grok', account: 'default', kind: 'recovered', windows: [], resetsAt: null },
  ]);
});

test('剩餘低於 20%、低於 10% 各提醒一次，跨級取最高級，回升後再下降會再提醒', () => {
  const low = (alerts: QuotaAlert[]) => alerts.map(alert => [alert.kind, alert.threshold, alert.remaining]);
  assert.deepEqual(low(quotaAlerts(state(usage(50)), state(fresh(85)))), [['low', 20, 15]]);
  assert.deepEqual(low(quotaAlerts(state(fresh(85)), state(usage(91, { quotaAt: '2026-10-10T12:10:00Z' })))), [['low', 10, 9]]);
  assert.deepEqual(low(quotaAlerts(state(usage(50)), state(fresh(95)))), [['low', 10, 5]]);
  assert.deepEqual(low(quotaAlerts(state(usage(85)), state(fresh(86)))), []);
  assert.deepEqual(low(quotaAlerts(state(usage(95)), state(fresh(85)))), []);
  assert.deepEqual(low(quotaAlerts(state(usage(95)), state(fresh(100)))), [['full', undefined, undefined]]);
  assert.deepEqual(quotaAlerts(state(usage(50)), state(fresh(80))), []);
  assert.deepEqual(low(quotaAlerts(state(usage(85)), state(fresh(30)))), []);
});

test('用滿後恢復前 5 分鐘與 1 分鐘各提醒一次，錯過 5 分鐘門檻只發 1 分鐘，新週期重新提醒', () => {
  const reset = Date.parse('2026-10-10T15:00:00Z');
  const full = state(usage(100));
  const fired = new Set<string>();
  const minutes = (now: number) => quotaCountdowns(full, now, fired).map(alert => alert.minutes);
  assert.deepEqual(minutes(reset - 6 * 60_000), []);
  assert.deepEqual(minutes(reset - 5 * 60_000), [5]);
  assert.deepEqual(minutes(reset - 4 * 60_000), []);
  assert.deepEqual(minutes(reset - 60_000), [1]);
  assert.deepEqual(minutes(reset - 30_000), []);
  assert.deepEqual(minutes(reset + 1), []);
  const late = new Set<string>();
  assert.deepEqual(quotaCountdowns(full, reset - 30_000, late).map(alert => alert.minutes), [1]);
  assert.deepEqual(quotaCountdowns(full, reset - 30_000, late), []);
  const next = state(usage(100, { windows: [{ label: '5h', usedPercent: 100, resetsAt: '2026-10-10T20:00:00Z' }] }));
  assert.deepEqual(quotaCountdowns(next, Date.parse('2026-10-10T20:00:00Z') - 240_000, late).map(alert => alert.minutes), [5]);
  assert.deepEqual(quotaCountdowns(state(usage(90)), reset - 60_000, new Set()), []);
  assert.deepEqual(quotaCountdowns(state(usage(100, { windows: [{ label: '5h', usedPercent: 100, resetsAt: null }] })), reset - 60_000, new Set()), []);
});
