import type { AiUsage, UsageState } from '../../shared/types.ts';

export interface QuotaAlert {
  ai: string;
  account: string;
  kind: 'full' | 'recovered';
  windows: string[];
  /** 全部已滿窗口都重置後才可恢復；有未知時間就不預告。 */
  resetsAt: string | null;
}

function fullWindows(usage: AiUsage) {
  return usage.windows.filter(window => window.usedPercent >= 100);
}

/** 只依查詢結果判斷，不因本機時間越過 reset 就聲稱額度已恢復。 */
function isQuotaFull(usage: AiUsage): boolean {
  return usage.limited || fullWindows(usage).length > 0;
}

/** 首次取得資料不通知；失敗仍保留舊狀態，成功的新查詢才觸發狀態轉移。 */
export function quotaAlerts(previous: UsageState, next: UsageState): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];
  for (const usage of next.ais) {
    const before = previous.ais.find(entry => entry.ai === usage.ai && entry.account === usage.account);
    if (!before?.quotaAt || !usage.quotaAt || usage.status !== 'ready') continue;
    if (Date.parse(usage.quotaAt) <= Date.parse(before.quotaAt)) continue;
    const full = isQuotaFull(usage);
    if (isQuotaFull(before) === full) continue;
    const windows = fullWindows(usage);
    const resets = windows.length && windows.every(window => window.resetsAt !== null)
      ? windows.map(window => window.resetsAt!).sort().at(-1)! : null;
    alerts.push({ ai: usage.ai, account: usage.account, kind: full ? 'full' : 'recovered', windows: full ? windows.map(window => window.label) : [], resetsAt: full ? resets : null });
  }
  return alerts;
}
