import type { BudgetCheck, BudgetRule, BudgetSettings, BudgetWarning, UsageHistoryView, UsageScope } from '../../shared/types.ts';
import { request } from '../api.ts';
import { getLocale, labelValue, t } from '../i18n/index.ts';
import { button, card, confirmModal, el, field, input, row, run, select, toast, UserError } from './dom.ts';
import { localDateTime } from './display.ts';

/**
 * Reported amounts grouped in the interface language; the unit label already names tokens, credits or USD. Claude costs
 * are summed floats, so unformatted totals also showed binary noise such as `0.30000000000000004`.
 */
function usageAmount(unit: BudgetRule['unit'], value: number): string {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: unit === 'tokens' ? 0 : unit === 'codexCredits' ? 2 : 4 }).format(value);
}
export function budgetWarningText(warning: BudgetWarning): string {
  if (warning.kind === 'quota') return t('budget.quotaWarning', { percent: warning.reported ?? 0 });
  if (warning.kind === 'cloudExpiry') return t('budget.expiryWarning', { at: localDateTime(warning.at!) });
  return t('budget.thresholdWarning', { unit: t(`budget.unit.${warning.unit!}`), reported: usageAmount(warning.unit!, warning.reported ?? 0), threshold: usageAmount(warning.unit!, warning.threshold ?? 0) });
}
/** Explicit acknowledgment is single-use and cannot silently restart a failed send. */
export async function confirmUsageRound(scope: UsageScope): Promise<boolean> {
  // An empty picker means no CLI is installed and signed in; the server would only answer a generic 400.
  if (!scope.ai) throw new UserError(t('onboarding.banner'));
  const check = await request<BudgetCheck>('/api/usage/check', scope);
  if (!check.acknowledgment) return true;
  if (!await confirmModal(t('budget.risk'), `${check.warnings.map(budgetWarningText).join('\n')}\n${t('budget.provenance')}`, t('budget.proceed'))) return false;
  await request('/api/usage/ack', { ...scope, acknowledgment: check.acknowledgment });
  return true;
}

/** Preview only; the backend checks again immediately before each provider send. */
export function workflowBudgetRisk(scope: UsageScope): HTMLElement {
  const panel = card(t('budget.risk'));
  panel.append(el('p', 'muted', t('budget.provenance')));
  const result = el('div'); panel.append(result);
  void run(async () => {
    const check = await request<BudgetCheck>('/api/usage/check', scope);
    if (check.unknown) result.append(el('p', 'muted', t('budget.unknown')));
    for (const warning of check.warnings) result.append(el('p', 'warning', budgetWarningText(warning)));
  });
  return panel;
}
/** Project-level work (editor proposals in the main folder) has no task. */
const scopeLabel = (scope: { project: string; task: string }) => scope.task ? `${scope.project} / ${scope.task}` : scope.project;
export function usageHistoryPanel(): HTMLElement {
  const panel = card(t('budget.history')); const result = el('div'); const project = input(); const task = input();
  panel.append(el('p', 'muted', t('budget.provenance')), row(field(t('budget.project'), project), field(t('budget.task'), task)), button(t('common.refresh'), async () => load()), result);
  let before: string | undefined;
  async function load(older = false): Promise<void> {
    const query = new URLSearchParams(); if (project.value.trim()) query.set('project', project.value.trim()); if (task.value.trim()) query.set('task', task.value.trim()); if (older && before) query.set('before', before);
    const view = await request<UsageHistoryView>(`/api/usage/history?${query}`);
    result.replaceChildren();
    if (!view.totals.length) result.append(el('p', 'muted', t('budget.unknown')));
    for (const total of view.totals) {
      const line = el('section', 'account-card'); line.append(el('h4', '', `${scopeLabel(total)} · ${total.ai} / ${total.account}`));
      line.append(el('p', '', `${labelValue(t('budget.unit.tokens'), total.tokenReports ? usageAmount('tokens', total.input + total.output) : t('budget.unknown'))} (${labelValue(t('budget.cached'), total.cachedReports ? usageAmount('tokens', total.cached) : t('budget.unknown'))})`));
      if (total.ai === 'codex') line.append(el('p', '', labelValue(t('budget.unit.codexCredits'), total.codexCreditReports ? usageAmount('codexCredits', total.codexCredits) : t('budget.unknown'))));
      if (total.ai === 'claude') line.append(el('p', '', labelValue(t('budget.unit.claudeUsd'), total.claudeUsdReports ? usageAmount('claudeUsd', total.claudeUsd) : t('budget.unknown'))));
      line.append(el('p', 'muted', t('budget.unknownCount', { count: total.unknownReports }))); result.append(line);
    }
    const entries = el('details', 'disclosure'); entries.append(el('summary', '', t('budget.reports')));
    for (const record of view.records) entries.append(el('p', '', `${localDateTime(record.at)} · ${scopeLabel(record)} · ${record.ai}/${record.account} · ${record.requestId} · ${record.sessionId ?? '—'} · ${labelValue(t('budget.unit.tokens'), record.usage ? usageAmount('tokens', record.usage.input + record.usage.output) : t('budget.unknown'))}${record.codexCredits !== undefined ? ` · ${labelValue(t('budget.unit.codexCredits'), usageAmount('codexCredits', record.codexCredits))}` : ''}${record.claudeUsd !== undefined ? ` · ${labelValue(t('budget.unit.claudeUsd'), usageAmount('claudeUsd', record.claudeUsd))}` : ''}`));
    result.append(entries); const last = view.records.at(-1); before = last ? `${last.at}|${last.requestId}` : undefined;
    if (view.hasMore) result.append(button(t('budget.older'), async () => load(true)));
  }
  void run(async () => load()); return panel;
}

export function budgetSettingsPanel(): HTMLElement {
  const panel = card(t('budget.settings')); const content = el('div'); panel.append(el('p', 'muted', t('budget.provenance')), content);
  void run(async () => {
    // `loaded` goes back as `previous`, so a stale panel cannot overwrite budgets saved from another window.
    let loaded = await request<BudgetSettings>('/api/usage/budgets'); const current = loaded; const rules = current.rules.map(rule => ({ ...rule }));
    const remaining = input(current.quotaRemainingPercent === null ? '' : String(current.quotaRemainingPercent)); remaining.type = 'number'; remaining.min = '0'; remaining.max = '100';
    const expiry = input(current.cloudExpiryHours === null ? '' : String(current.cloudExpiryHours)); expiry.type = 'number'; expiry.min = '0'; expiry.max = '8760';
    const list = el('div');
    function draw(): void {
      list.replaceChildren();
      for (const rule of rules) {
        const item = el('section', 'account-card');
        for (const key of ['project', 'task', 'ai', 'account'] as const) { const value = input(rule[key] ?? ''); value.maxLength = 256; value.oninput = () => { if (value.value.trim()) rule[key] = value.value.trim(); else delete rule[key]; }; item.append(field(t(`budget.${key}`), value)); }
        const unit = select((['tokens', 'codexCredits', 'claudeUsd'] as const).map(value => ({ value, label: t(`budget.unit.${value}`) })), rule.unit); unit.onchange = () => { rule.unit = unit.value as BudgetRule['unit']; };
        const threshold = input(String(rule.threshold)); threshold.type = 'number'; threshold.min = '0.000001'; threshold.step = 'any'; threshold.oninput = () => { rule.threshold = Number(threshold.value); };
        const since = input(rule.since); since.oninput = () => { rule.since = since.value; };
        item.append(field(t('budget.unit'), unit), field(t('budget.threshold'), threshold), field(t('budget.since'), since), button(t('common.remove'), () => { rules.splice(rules.indexOf(rule), 1); draw(); })); list.append(item);
      }
    }
    draw();
    content.append(field(t('budget.remaining'), remaining), field(t('budget.expiry'), expiry), el('p', 'muted', t('budget.optional')), list, row(button(t('budget.add'), () => { if (rules.length >= 100) return; rules.push({ id: crypto.randomUUID(), unit: 'tokens', threshold: 100000, since: new Date().toISOString() }); draw(); }), button(t('common.save'), async () => { loaded = await request<BudgetSettings>('/api/usage/budgets', { rules, quotaRemainingPercent: remaining.value === '' ? null : Number(remaining.value), cloudExpiryHours: expiry.value === '' ? null : Number(expiry.value), previous: loaded }); toast(t('common.saved')); }, 'primary')));
  }); return panel;
}
