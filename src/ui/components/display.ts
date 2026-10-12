import { CREDITS_UNIT, type AppState, type CloudCredits, type ExtraUsage } from '../../shared/types.ts';
import { getLocale, t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/zh-TW.ts';

export function aiLabel(name: string): string {
  if (name === 'claude') return 'Claude';
  if (name === 'codex') return 'Codex';
  if (name === 'grok') return 'Grok';
  if (name === 'gemini') return 'Gemini';
  return name === '人' ? t('ai.human') : name;
}
export function modelLabel(state: AppState, ai: string, model = ''): string {
  return state.ais.find(info => info.name === ai)?.models.find(info => info.id === model)?.label ?? model;
}
export function effortLabel(effort = ''): string {
  if (['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) return t(`effort.${effort}` as MessageKey);
  return effort;
}
export function sourceLabel(source: string): string {
  if (['cli-cache', 'cli', 'builtin', 'unavailable'].includes(source)) return t(`source.${source}` as MessageKey);
  return source;
}
export function prepaidLabel(cents: number): string {
  return t('usage.prepaidBalance', { balance: new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(cents / 100) });
}
/** 額外使用額度的一行文字；金額單位是幣別最小單位（cents），依幣別小數位換算。 */
export function extraUsageLabel(extra: ExtraUsage): string {
  const title = t('usage.extraTitle');
  const format = (value: number): string => {
    if (extra.currency === CREDITS_UNIT) return t('usage.extraCredits', { amount: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 }).format(value) });
    const money = new Intl.NumberFormat(getLocale(), { style: 'currency', currency: extra.currency });
    return money.format(value / 10 ** (money.resolvedOptions().maximumFractionDigits ?? 2));
  };
  return `${title} · ${extra.unlimited ? t('usage.extraUnlimited') : t('usage.extraBalance', { amount: format(extra.balance) })}`;
}
/** 雲端工作階段點數的一行文字：餘額（美元）＋到期時間。 */
export function cloudCreditsLabel(credits: CloudCredits): string {
  const amount = new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(credits.balance / 100);
  const expires = credits.expiresAt ? ` · ${t('usage.cloudExpires', { at: localDateTime(credits.expiresAt) })}` : '';
  return `${t('usage.cloudTitle')} · ${t('usage.extraBalance', { amount })}${expires}`;
}
export function quotaLabel(label: string): string {
  switch (label) {
    case '7d credits': return t('usage.weeklyCredits');
    case 'monthly credits': return t('usage.monthlyCredits');
    case 'credits': return t('usage.credits');
    case 'on-demand': return t('usage.onDemand');
    default: return label.replace(/ · Weekly Limit Remaining$/, '');
  }
}
/** 含年月日的本地時間（YYYY-MM-DD HH:mm）。 */
// Ledger dates such as PROJECT.md `updated` carry no time; `new Date('YYYY-MM-DD')` would read them as UTC midnight.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export function localDateTime(value: string): string {
  if (DATE_ONLY.test(value)) return value;
  const date = new Date(value); if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** Binary-scaled size (e.g. 1.5 GB) in the given locale's unit format. */
export function formatBytes(bytes: number, locale = getLocale()): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: units[unit], unitDisplay: 'short', maximumFractionDigits: unit ? 1 : 0 }).format(value);
}

export function localTime(value: string): string {
  if (!value) return '—';
  if (DATE_ONLY.test(value)) return value;
  const date = new Date(value); if (Number.isNaN(date.getTime())) return value;
  const now = new Date(); const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return time;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}
