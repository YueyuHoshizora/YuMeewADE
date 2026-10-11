import type { AiUsage, AppState, QuotaWindow, UsageState } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import { aiLabel, localTime } from './display.ts';
import { el } from './dom.ts';

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

function usageItem(ai: string, usage: AiUsage | undefined, now: number): HTMLElement {
  const item = el('div', 'usage-item');
  item.append(el('span', 'usage-ai', aiLabel(ai)));
  if (!usage?.quotaAt) {
    const none = el('span', 'usage-none', '—'); none.title = t('usage.none'); item.append(none);
  } else {
    const quota = el('span', 'usage-quota'); quota.title = t('usage.quotaAt', { at: localTime(usage.quotaAt) });
    quota.append(...usage.windows.map(window => quotaWindow(window, now)));
    if (usage.limited) quota.append(el('span', 'usage-limited', t('usage.limited')));
    item.append(quota);
  }
  return item;
}

/** 底部狀態列：已安裝的 AI（以及任何回報過額度的 AI）各一格額度，最右邊是所有對話合計的即時 tok/s。 */
export function usageBar(state: AppState, usage: UsageState, now = Date.now()): HTMLElement[] {
  const names = state.ais.filter(info => info.name !== 'mock' && info.available).map(info => info.name as string);
  for (const entry of usage.ais) if (!names.includes(entry.ai)) names.push(entry.ai);
  const speed = el('span', usage.tokensPerSecond > 0 ? 'usage-speed running' : 'usage-speed', `${usage.tokensPerSecond} tok/s`);
  speed.title = t('usage.speed');
  return [...names.map(ai => usageItem(ai, usage.ais.find(entry => entry.ai === ai), now)), speed];
}
