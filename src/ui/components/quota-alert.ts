import type { AiUsage, QuotaWindow, UsageState } from '../../shared/types.ts';

export interface QuotaAlert {
  ai: string;
  account: string;
  /** low＝剩餘低於 threshold%；full＝剩餘 0%；soon＝距離恢復剩 minutes 分鐘；recovered＝已恢復。 */
  kind: 'low' | 'full' | 'soon' | 'recovered';
  windows: string[];
  /** 全部已滿窗口都重置後才可恢復；有未知時間就不預告。 */
  resetsAt: string | null;
  /** kind＝low：20 或 10。 */
  threshold?: 20 | 10;
  /** kind＝low：觸發窗口中最低的剩餘百分比（無條件進位到整數）。 */
  remaining?: number;
  /** kind＝soon：5 或 1。 */
  minutes?: 5 | 1;
}

/** Grok 的隨用隨付額度不是方案額度，不參與提醒。 */
function relevantWindows(usage: AiUsage): QuotaWindow[] {
  return usage.windows.filter(window => usage.ai !== 'grok' || window.label !== 'on-demand');
}

function fullWindows(usage: AiUsage): QuotaWindow[] {
  return relevantWindows(usage).filter(window => window.usedPercent >= 100);
}

/** 只依查詢結果判斷，不因本機時間越過 reset 就聲稱額度已恢復。 */
function isQuotaFull(usage: AiUsage): boolean {
  return usage.limited || fullWindows(usage).length > 0;
}

/** 0＝正常；1＝剩餘低於 20%；2＝剩餘低於 10%；3＝用滿（剩餘 0%）。 */
function level(usage: AiUsage): 0 | 1 | 2 | 3 {
  if (isQuotaFull(usage)) return 3;
  const used = Math.max(0, ...relevantWindows(usage).map(window => window.usedPercent));
  return used > 90 ? 2 : used > 80 ? 1 : 0;
}

/** 全部已滿窗口都有重置時間時，最晚的那個才是恢復時間；有未知就不預告。 */
function recoveryTime(usage: AiUsage): string | null {
  const windows = fullWindows(usage);
  return windows.length && windows.every(window => window.resetsAt !== null)
    ? windows.map(window => window.resetsAt!).sort().at(-1)! : null;
}

/** 首次取得資料不通知；失敗仍保留舊狀態，成功的新查詢才觸發狀態轉移。 */
export function quotaAlerts(previous: UsageState, next: UsageState): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];
  for (const usage of next.ais) {
    const before = previous.ais.find(entry => entry.ai === usage.ai && entry.account === usage.account);
    if (!before?.quotaAt || !usage.quotaAt || usage.status !== 'ready') continue;
    if (Date.parse(usage.quotaAt) <= Date.parse(before.quotaAt)) continue;
    const was = level(before);
    const now = level(usage);
    const base = { ai: usage.ai, account: usage.account };
    if (was === 3 && now < 3) alerts.push({ ...base, kind: 'recovered', windows: [], resetsAt: null });
    else if (now === 3 && was < 3) alerts.push({ ...base, kind: 'full', windows: fullWindows(usage).map(window => window.label), resetsAt: recoveryTime(usage) });
    else if ((now === 1 || now === 2) && now > was) {
      const threshold = now === 2 ? 10 : 20;
      const hit = relevantWindows(usage).filter(window => window.usedPercent > 100 - threshold);
      const remaining = Math.ceil(100 - Math.max(...hit.map(window => window.usedPercent)));
      alerts.push({ ...base, kind: 'low', windows: hit.map(window => window.label), resetsAt: null, threshold, remaining });
    }
  }
  return alerts;
}

const SOON_MINUTES = [1, 5] as const;

/**
 * 用滿且恢復時間已知時，在恢復前 5 分鐘與 1 分鐘各提醒一次；`fired` 記錄已提醒的（帳號、恢復時間、分鐘），
 * 由呼叫端保存。剛好錯過 5 分鐘門檻（例如開啟時只剩 30 秒）只發 1 分鐘那則。
 */
export function quotaCountdowns(state: UsageState, now: number, fired: Set<string>): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];
  for (const usage of state.ais) {
    if (!usage.quotaAt || !isQuotaFull(usage)) continue;
    const resetsAt = recoveryTime(usage);
    const remaining = resetsAt === null ? 0 : Date.parse(resetsAt) - now;
    if (resetsAt === null || !(remaining > 0)) continue;
    const key = (minutes: number) => `${usage.ai}|${usage.account}|${resetsAt}|${minutes}`;
    const minutes = SOON_MINUTES.find(m => remaining <= m * 60_000 && !fired.has(key(m)));
    if (minutes === undefined) continue;
    for (const m of SOON_MINUTES) if (m >= minutes) fired.add(key(m));
    alerts.push({ ai: usage.ai, account: usage.account, kind: 'soon', windows: fullWindows(usage).map(window => window.label), resetsAt, minutes });
  }
  return alerts;
}
