import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageHistory, budgetSettings } from './usage-history.ts';
import type { UsageState } from '../shared/types.ts';

const scope = { project: 'project', task: 'task', ai: 'claude', account: 'default' };
const empty: UsageState = { ais: [], tokensPerSecond: null };
test('durable attributed reports preserve unknown and separate units without counting cache twice', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-history-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const history = new UsageHistory(root);
  await Promise.all([
    history.record({ ...scope, requestId: 'one', sessionId: 'session', usage: { input: 10, output: 5, cached: 8 }, claudeUsd: 0.03 }),
    history.record({ ...scope, requestId: 'two', usage: null }),
    history.record({ ...scope, ai: 'codex', requestId: 'three', usage: { input: 2, output: 3 }, codexCredits: 0.5 }),
  ]);
  await history.record({ ...scope, requestId: 'two', usage: null });
  const view = await new UsageHistory(root).view();
  assert.equal(view.records.length, 3);
  const claude = view.totals.find(entry => entry.ai === 'claude')!;
  assert.equal(claude.input + claude.output, 15); assert.equal(claude.cached, 8); assert.equal(claude.unknownReports, 1); assert.equal(claude.claudeUsd, 0.03); assert.equal(claude.codexCreditReports, 0);
  assert.equal(view.totals.find(entry => entry.ai === 'codex')!.codexCredits, 0.5);
  await assert.rejects(history.record({ ...scope, requestId: 'bad', usage: null, codexCredits: 1 }));
});
test('a report cut short by a crash is skipped; history, later reports and launches keep working', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-torn-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const history = new UsageHistory(root);
  await history.record({ ...scope, requestId: 'good', usage: { input: 10, output: 2 } });
  await fs.appendFile(path.join(root, '.yumeewade', 'usage.jsonl'), '{"requestId":"interrupted');
  await history.record({ ...scope, requestId: 'next', usage: { input: 1, output: 1 } });
  assert.deepEqual((await history.view()).records.map(entry => entry.requestId).sort(), ['good', 'next']);
  await history.assertProceed(scope, empty);
});
test('configured warnings require current scoped one-use acknowledgment and never assert costs for unknown usage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-budget-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.parse('2026-10-11T00:00:00Z'); const history = new UsageHistory(root, () => now);
  await history.saveSettings({ rules: [{ id: 'tokens', project: scope.project, unit: 'tokens', threshold: 10, since: '2026-01-01T00:00:00Z' }], quotaRemainingPercent: null, cloudExpiryHours: null });
  assert.equal((await history.check(scope, empty)).unknown, true);
  await history.record({ ...scope, requestId: 'one', usage: { input: 10, output: 1 } });
  await assert.rejects(history.assertProceed(scope, empty));
  const check = await history.check(scope, empty); assert.equal(check.warnings[0]!.reported, 11);
  await assert.rejects(history.acknowledge({ ...scope, task: 'other' }, empty, check.acknowledgment!));
  await history.acknowledge(scope, empty, check.acknowledgment!); await history.assertProceed(scope, empty); await assert.rejects(history.assertProceed(scope, empty));
  await history.acknowledge(scope, empty, check.acknowledgment!); now += 300001; await assert.rejects(history.assertProceed(scope, empty));
  await history.acknowledge(scope, empty, check.acknowledgment!);
  await history.record({ ...scope, requestId: 'two', usage: { input: 1, output: 1 } });
  await assert.rejects(history.assertProceed(scope, empty));
});
test('reported money that adds up to exactly the threshold warns despite binary rounding', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-money-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const history = new UsageHistory(root);
  await history.saveSettings({ rules: [{ id: 'usd', unit: 'claudeUsd', threshold: 0.8, since: '2026-01-01T00:00:00Z' }], quotaRemainingPercent: null, cloudExpiryHours: null });
  await history.record({ ...scope, requestId: 'one', usage: null, claudeUsd: 0.1 });
  await history.record({ ...scope, requestId: 'two', usage: null, claudeUsd: 0.7 });
  assert.deepEqual((await history.check(scope, empty)).warnings, [{ kind: 'threshold', ruleId: 'usd', unit: 'claudeUsd', reported: 0.8, threshold: 0.8 }]);
  await assert.rejects(history.assertProceed(scope, empty), { detail: 'usage_ack_required' });
});
test('an account the CLI reports as limited warns with nothing remaining, even without percentage windows', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-limited-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const live: UsageState = { ais: [{ ai: 'claude', account: 'default', status: 'ready', windows: [], limited: true, quotaAt: '2026-10-13T00:00:00Z' }], tokensPerSecond: null };
  assert.deepEqual((await new UsageHistory(root).check(scope, live)).warnings, [{ kind: 'quota', reported: 0, threshold: 0 }]);
});
test('project-level work without a task is budget-checked and recorded under the project', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-project-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const history = new UsageHistory(root);
  const projectScope = { ...scope, task: '' };
  await history.saveSettings({ rules: [{ id: 'tokens', project: scope.project, unit: 'tokens', threshold: 10, since: '2026-01-01T00:00:00Z' }], quotaRemainingPercent: null, cloudExpiryHours: null });
  await history.assertProceed(projectScope, empty);
  await history.record({ ...projectScope, requestId: 'one', usage: { input: 10, output: 1 } });
  assert.deepEqual((await history.view()).totals.map(total => [total.project, total.task, total.input + total.output]), [['project', '', 11]]);
  // The project rule now warns for both project-level and task work.
  await assert.rejects(history.assertProceed(projectScope, empty), { detail: 'usage_ack_required' });
  await assert.rejects(history.assertProceed(scope, empty), { detail: 'usage_ack_required' });
});
test('budget settings saved from a stale editor are refused instead of overwriting newer budgets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-budget-stale-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const history = new UsageHistory(root);
  const loaded = await history.settings();
  const mine = { rules: [{ id: 'a', unit: 'tokens', threshold: 10, since: '2026-01-01T00:00:00.000Z' }], quotaRemainingPercent: null, cloudExpiryHours: null };
  const saved = await history.saveSettings(mine, loaded);
  // Another window still holds the original settings.
  await assert.rejects(history.saveSettings({ ...loaded, quotaRemainingPercent: 5 }, loaded), { detail: 'budget_changed' });
  assert.deepEqual(await history.settings(), saved);
  await history.saveSettings({ ...saved, quotaRemainingPercent: 5 }, saved);
  assert.equal((await history.settings()).quotaRemainingPercent, 5);
});
test('quota warnings respect unavailable provenance and cloud expiry does not convert balances into spend', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-quota-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const history = new UsageHistory(root, () => Date.parse('2026-10-11T00:00:00Z'));
  await history.saveSettings({ rules: [], quotaRemainingPercent: 20, cloudExpiryHours: 24 });
  const live: UsageState = { tokensPerSecond: 500, ais: [{ ai: 'claude', account: 'default', status: 'ready', windows: [{ label: 'session', usedPercent: 85, resetsAt: null }], limited: false, quotaAt: '2026-10-11T00:00:00Z', cloudCredits: { balance: 100, expiresAt: '2026-10-11T12:00:00Z' } }] };
  assert.deepEqual((await history.check(scope, live)).warnings.map(warning => warning.kind), ['quota', 'cloudExpiry']);
  live.ais[0]!.status = 'unavailable'; assert.deepEqual((await history.check(scope, live)).warnings, []);
  assert.deepEqual((await history.view()).records, []);
  assert.throws(() => budgetSettings({ rules: [{ id: 'x', task: 'x', unit: 'tokens', threshold: 1, since: '2026-01-01' }], quotaRemainingPercent: null, cloudExpiryHours: null }));
});
test('same timestamp pagination never skips reports', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-pages-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const history = new UsageHistory(root); const at = '2026-10-11T00:00:00Z';
  for (let index = 0; index < 201; index++) await history.record({ ...scope, requestId: String(index).padStart(4, '0'), at, usage: null });
  const first = await history.view(); assert.equal(first.records.length, 200); assert.equal(first.hasMore, true);
  const last = first.records.at(-1)!; const next = await history.view({}, `${last.at}|${last.requestId}`);
  assert.equal(next.records.length, 1); assert.equal(next.records[0]!.requestId, '0000');
});
