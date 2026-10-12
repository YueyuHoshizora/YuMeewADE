import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { appendLine, readJson, withFileLocks, writeJson } from '../shared/fsx.ts';
import { AppError } from '../shared/errors.ts';
import type { UsageState } from '../shared/types.ts';
import type { BudgetCheck, BudgetRule, BudgetSettings, BudgetWarning, ReportedUsageRecord, UsageHistoryView, UsageScope, UsageTotals } from '../shared/usage-history-types.ts';

const MAX_BYTES = 128 * 1024 * 1024;
const DEFAULTS: BudgetSettings = { rules: [], quotaRemainingPercent: null, cloudExpiryHours: null };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value);
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const iso = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
/** `task` is empty for project-level work (editor proposals in the main folder). */
export function usageScope(value: unknown): UsageScope {
  if (!object(value) || !text(value.project) || !(value.task === '' || text(value.task)) || !text(value.ai) || !text(value.account)) throw new AppError('bad_request');
  return { project: value.project, task: value.task, ai: value.ai, account: value.account };
}
export function budgetSettings(value: unknown): BudgetSettings {
  if (!object(value) || !Array.isArray(value.rules) || value.rules.length > 100 || !(value.quotaRemainingPercent === null || amount(value.quotaRemainingPercent) && value.quotaRemainingPercent <= 100) || !(value.cloudExpiryHours === null || amount(value.cloudExpiryHours) && value.cloudExpiryHours <= 8760)) throw new AppError('bad_request');
  const ids = new Set<string>();
  const rules: BudgetRule[] = value.rules.map((item: unknown) => {
    if (!object(item) || !text(item.id) || ids.has(item.id) || !['tokens', 'codexCredits', 'claudeUsd'].includes(String(item.unit)) || !amount(item.threshold) || item.threshold === 0 || !iso(item.since)) throw new AppError('bad_request');
    ids.add(item.id);
    const rule: BudgetRule = { id: item.id, unit: item.unit as BudgetRule['unit'], threshold: item.threshold, since: new Date(item.since).toISOString() };
    for (const key of ['project', 'task', 'ai', 'account'] as const) if (item[key] !== undefined) { if (!text(item[key])) throw new AppError('bad_request'); rule[key] = item[key]; }
    if (rule.task && !rule.project) throw new AppError('bad_request');
    return rule;
  });
  return { rules, quotaRemainingPercent: value.quotaRemainingPercent, cloudExpiryHours: value.cloudExpiryHours };
}
function record(value: unknown): ReportedUsageRecord {
  const scope = usageScope(value);
  if (!object(value) || !text(value.requestId) || !iso(value.at) || value.provenance !== 'provider-reported' || !(value.usage === null || object(value.usage) && amount(value.usage.input) && amount(value.usage.output) && (value.usage.cached === undefined || amount(value.usage.cached))) || value.sessionId !== undefined && !text(value.sessionId) || value.codexCredits !== undefined && (!amount(value.codexCredits) || scope.ai !== 'codex') || value.claudeUsd !== undefined && (!amount(value.claudeUsd) || scope.ai !== 'claude')) throw new AppError('bad_request');
  return { ...scope, requestId: value.requestId, at: new Date(value.at).toISOString(), usage: value.usage === null ? null : { input: value.usage.input as number, output: value.usage.output as number, ...(value.usage.cached !== undefined ? { cached: value.usage.cached as number } : {}) }, provenance: 'provider-reported', ...(value.sessionId ? { sessionId: value.sessionId as string } : {}), ...(value.codexCredits !== undefined ? { codexCredits: value.codexCredits as number } : {}), ...(value.claudeUsd !== undefined ? { claudeUsd: value.claudeUsd as number } : {}) };
}
function matches(scope: UsageScope, rule: Partial<UsageScope>): boolean { return (['project', 'task', 'ai', 'account'] as const).every(key => rule[key] === undefined || rule[key] === scope[key]); }

/** Only final provider reports enter this ledger; rate samples and balance changes never become costs. */
export class UsageHistory {
  private readonly file: string;
  private readonly settingsFile: string;
  private readonly grants = new Map<string, number>();
  private readonly now: () => number;
  constructor(root: string, now: () => number = Date.now) { this.file = path.join(root, '.yumeewade', 'usage.jsonl'); this.settingsFile = path.join(root, '.yumeewade', 'budgets.json'); this.now = now; }
  async settings(): Promise<BudgetSettings> { return budgetSettings(await readJson<unknown>(this.settingsFile, DEFAULTS)); }
  /** `previous` is the settings as the editor loaded them; settings saved meanwhile (another window) are a conflict, not overwritten. */
  async saveSettings(value: unknown, previous?: unknown): Promise<BudgetSettings> {
    const next = budgetSettings(value); const expected = previous === undefined ? undefined : JSON.stringify(budgetSettings(previous));
    await withFileLocks([this.settingsFile], async () => {
      if (expected !== undefined && JSON.stringify(await this.settings()) !== expected) throw new AppError('conflict', 'budget_changed');
      await writeJson(this.settingsFile, next);
    });
    this.grants.clear(); return next;
  }
  async record(value: Omit<ReportedUsageRecord, 'at' | 'provenance'> & { at?: string }): Promise<void> {
    const next = record({ ...value, at: value.at ?? new Date(this.now()).toISOString(), provenance: 'provider-reported' });
    await withFileLocks([this.file], async () => {
      const size = await fs.stat(this.file).then(stat => stat.size, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size + Buffer.byteLength(JSON.stringify(next)) + 1 > MAX_BYTES) throw new AppError('unavailable');
      // Completion hooks are retryable: do not charge the same request twice.
      for await (const previous of this.records()) if (previous.requestId === next.requestId) {
        if (JSON.stringify(previous) !== JSON.stringify({ ...next, at: value.at === undefined ? previous.at : next.at })) throw new AppError('conflict');
        return;
      }
      await appendLine(this.file, JSON.stringify(next));
    });
  }
  private async *records(): AsyncGenerator<ReportedUsageRecord> {
    const size = await fs.stat(this.file).then(stat => stat.size, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error; });
    if (!size) return;
    if (size > MAX_BYTES) throw new AppError('too_large');
    const stream = createReadStream(this.file, { encoding: 'utf8' }); const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length > 8192) throw new AppError('too_large');
        if (!line) continue;
        // An append cut short (crash, disk full) leaves a fragment that is not JSON; it never became a report. appendLine
        // starts the next record on a fresh line, so skipping the fragment keeps recording and launches working.
        let value: unknown; try { value = JSON.parse(line); } catch { continue; }
        yield record(value);
      }
    }
    finally { lines.close(); stream.destroy(); }
  }
  async view(filter: Partial<UsageScope> = {}, before?: string): Promise<UsageHistoryView> {
    const totals = new Map<string, UsageTotals>(); const records: ReportedUsageRecord[] = []; let count = 0;
    for await (const entry of this.records()) {
      if (!matches(entry, filter)) continue;
      const key = JSON.stringify([entry.project, entry.task, entry.ai, entry.account]);
      let total = totals.get(key);
      if (!total) { if (totals.size >= 20000) throw new AppError('unavailable'); total = { project: entry.project, task: entry.task, ai: entry.ai, account: entry.account, input: 0, output: 0, cached: 0, tokenReports: 0, cachedReports: 0, unknownReports: 0, codexCredits: 0, codexCreditReports: 0, claudeUsd: 0, claudeUsdReports: 0, requests: 0 }; totals.set(key, total); }
      total.requests++;
      if (entry.usage) {
        total.input += entry.usage.input; total.output += entry.usage.output; total.tokenReports++;
        if (entry.usage.cached !== undefined) { total.cached += entry.usage.cached; total.cachedReports++; }
      } else total.unknownReports++;
      if (entry.codexCredits !== undefined) { total.codexCredits += entry.codexCredits; total.codexCreditReports++; }
      if (entry.claudeUsd !== undefined) { total.claudeUsd += entry.claudeUsd; total.claudeUsdReports++; }
      const cursor = before?.split('|');
      if (!cursor || entry.at < cursor[0]! || entry.at === cursor[0] && entry.requestId < cursor.slice(1).join('|')) { count++; records.push(entry); records.sort((a, b) => a.at !== b.at ? a.at > b.at ? -1 : 1 : a.requestId === b.requestId ? 0 : a.requestId > b.requestId ? -1 : 1); if (records.length > 200) records.pop(); }
    }
    return { records, totals: [...totals.values()], settings: await this.settings(), hasMore: count > records.length };
  }
  async check(raw: UsageScope, live: UsageState): Promise<BudgetCheck> {
    const scope = usageScope(raw); const settings = await this.settings(); const rules = settings.rules.filter(rule => matches(scope, rule)); const sums = rules.map(() => 0); let reported = false;
    // Money is summed in millionths so reported amounts that add up to exactly the threshold (0.1 + 0.7 vs 0.8) are not lost to binary rounding.
    const scale = (unit: string) => unit === 'tokens' ? 1 : 1e6;
    for await (const entry of this.records()) {
      if (matches(entry, scope) && entry.usage) reported = true;
      rules.forEach((rule, index) => { if (entry.at < rule.since || !matches(entry, rule)) return; sums[index]! += rule.unit === 'tokens' ? entry.usage ? entry.usage.input + entry.usage.output : 0 : Math.round((entry[rule.unit] ?? 0) * 1e6); });
    }
    const warnings: BudgetWarning[] = [];
    rules.forEach((rule, index) => { if (sums[index]! >= Math.round(rule.threshold * scale(rule.unit))) warnings.push({ kind: 'threshold', ruleId: rule.id, unit: rule.unit, reported: sums[index]! / scale(rule.unit), threshold: rule.threshold }); });
    const quota = live.ais.find(entry => entry.ai === scope.ai && entry.account === scope.account);
    if (quota?.status === 'ready') {
      const windows = quota.windows.filter(window => scope.ai !== 'grok' || window.label !== 'on-demand');
      // A limited account (the CLI reports the limit reached, possibly with no percentage windows at all) has none left.
      const remaining = quota.limited ? 0 : Math.max(0, 100 - Math.max(0, ...windows.map(window => window.usedPercent)));
      if (quota.limited || settings.quotaRemainingPercent !== null && windows.length > 0 && remaining <= settings.quotaRemainingPercent) warnings.push({ kind: 'quota', reported: remaining, threshold: settings.quotaRemainingPercent ?? 0 });
      if (settings.cloudExpiryHours !== null && quota.cloudCredits?.expiresAt && quota.cloudCredits.balance > 0 && Date.parse(quota.cloudCredits.expiresAt) <= this.now() + settings.cloudExpiryHours * 3600000) warnings.push({ kind: 'cloudExpiry', at: quota.cloudCredits.expiresAt });
    }
    const acknowledgment = warnings.length ? createHash('sha256').update(JSON.stringify([scope, warnings, settings])).digest('hex') : null;
    return { scope, warnings, acknowledgment, unknown: !reported };
  }
  async acknowledge(scope: UsageScope, live: UsageState, token: string): Promise<void> {
    const check = await this.check(scope, live);
    if (!check.acknowledgment || token !== check.acknowledgment) throw new AppError('conflict');
    for (const [key, expires] of this.grants) if (expires <= this.now()) this.grants.delete(key);
    if (this.grants.size >= 1000) throw new AppError('unavailable');
    this.grants.set(token, this.now() + 300000);
  }
  async assertProceed(scope: UsageScope, live: UsageState): Promise<void> {
    const check = await this.check(scope, live); if (!check.acknowledgment) return;
    const expires = this.grants.get(check.acknowledgment); this.grants.delete(check.acknowledgment);
    if (!expires || expires <= this.now()) throw new AppError('conflict', 'usage_ack_required');
  }
}
