import type { AppState } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/zh-TW.ts';

export function aiLabel(name: string): string {
  if (name === 'claude') return 'Claude';
  if (name === 'codex') return 'Codex';
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
  if (['cli-cache', 'cli', 'builtin'].includes(source)) return t(`source.${source}` as MessageKey);
  return source;
}
export function localTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value); if (Number.isNaN(date.getTime())) return value;
  const now = new Date(); const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return time;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}
