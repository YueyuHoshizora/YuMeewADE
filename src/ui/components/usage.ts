import type { AiUsage, AppState, QuotaWindow, UsageState } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import { aiLabel, localTime } from './display.ts';
import { button, el } from './dom.ts';

/** 已用比例到這裡開始提醒／警告。 */
const WARN_PERCENT = 70;
const DANGER_PERCENT = 90;

function quotaWindow(window: QuotaWindow, now: number): HTMLElement {
  const node = el('span', 'usage-window');
  const percent = `${Math.round(window.usedPercent)}%`;
  // 重置時間已過：CLI 還沒回報新窗口的用量，舊比例不能再當真。
  if (window.resetsAt && Date.parse(window.resetsAt) <= now) {
    node.classList.add('stale');
    node.append(el('span', 'usage-window-label', window.label), el('span', 'usage-percent', '—'));
    node.title = t('usage.windowReset', { label: window.label, reset: localTime(window.resetsAt) });
    return node;
  }
  if (window.usedPercent >= DANGER_PERCENT) node.classList.add('danger');
  else if (window.usedPercent >= WARN_PERCENT) node.classList.add('warn');
  const meter = el('span', 'usage-meter'); const fill = el('span', 'usage-meter-fill');
  fill.style.width = `${Math.min(100, window.usedPercent)}%`; meter.append(fill);
  node.append(el('span', 'usage-window-label', window.label), meter, el('span', 'usage-percent', percent));
  node.title = window.resetsAt
    ? t('usage.window', { label: window.label, percent, reset: localTime(window.resetsAt) })
    : t('usage.windowNoReset', { label: window.label, percent });
  return node;
}

function usageItem(ai: string, name: string | undefined, usage: AiUsage | undefined, now: number, onDetails?: (ai: string) => void): HTMLElement {
  const item = onDetails ? button('', () => onDetails(ai), 'usage-item usage-action') : el('div', 'usage-item');
  item.append(el('span', 'usage-ai', aiLabel(ai)));
  if (name) item.append(el('span', 'usage-account', name));
  if (onDetails) item.setAttribute('aria-label', t('usage.openDetails', { ai: aiLabel(ai) }));
  if (usage?.status === 'unavailable') item.append(el('span', 'usage-unavailable', t('usage.unavailable')));
  if (!usage?.quotaAt) {
    const none = el('span', 'usage-none', '—'); none.title = t('usage.noData'); item.append(none);
  } else {
    const quota = el('span', 'usage-quota'); quota.title = t('usage.quotaAt', { at: localTime(usage.quotaAt) });
    quota.append(...usage.windows.map(window => quotaWindow(window, now)));
    if (usage.limited) quota.append(el('span', 'usage-limited', t('usage.limited')));
    item.append(quota);
  }
  return item;
}

/** 底部列只顯示各 AI 使用中帳號；最右邊是近期實測平均輸出速度。 */
export function usageBar(state: AppState, usage: UsageState, now = Date.now(), onDetails?: (ai: string) => void): HTMLElement[] {
  const names = ['claude', 'codex'];
  for (const info of state.ais) if (info.name !== 'mock' && info.available && !names.includes(info.name)) names.push(info.name);
  for (const entry of usage.ais) if (entry.ai !== 'mock' && !names.includes(entry.ai)) names.push(entry.ai);
  const measured = usage.tokensPerSecond;
  const speed = el('span', measured !== null && measured > 0 ? 'usage-speed running' : 'usage-speed', t('usage.averageSpeed', { speed: measured ?? '—' }));
  speed.title = t('usage.measuredSpeed');
  return [...names.map(ai => {
    const account = state.settings.activeAccounts[ai] ?? 'default';
    const name = state.settings.accounts[ai]?.find(entry => entry.id === account)?.name;
    return usageItem(ai, name, usage.ais.find(entry => entry.ai === ai && entry.account === account), now, onDetails);
  }), speed];
}
