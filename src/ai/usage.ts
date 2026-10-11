// 帳戶額度與即時輸出速度只存記憶體；不同 CLI 設定目錄的查詢與回合事件各自隔離。
import type { CliEvent, CliProvider } from '../cli/provider.ts';
import { log } from '../shared/log.ts';
import type { AiUsage, Settings, UsageState } from '../shared/types.ts';

export type UsageEvent = Extract<CliEvent, { type: 'quota' | 'tokens' }>;

/** 完成的實測保留四秒；沒有用量的串流不猜 token，也不冒充即時解碼速度。 */
const RATE_WINDOW_MS = 4000;
/** 有輸出時多久重算並推送一次。 */
const TICK_MS = 1000;

interface Sample {
  start: number;
  end: number;
  count: number;
}

export class UsageBoard {
  private readonly items = new Map<string, AiUsage>();
  private readonly onChange: (usage: UsageState) => void;
  private readonly now: () => number;
  private readonly samples = new Map<string, Sample>();
  private rate: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private resetTimer: NodeJS.Timeout | null = null;
  private codexReset: string | undefined;
  private readonly queries = new Map<string, Promise<void>>();
  private targets: Set<string> | null = null;
  private closed = false;

  constructor(onChange: (usage: UsageState) => void, now: () => number = Date.now) {
    this.onChange = onChange;
    this.now = now;
  }

  snapshot(): UsageState {
    return { ais: [...this.items.values()].sort((a, b) => a.ai.localeCompare(b.ai)), tokensPerSecond: this.rate, ...(this.codexReset ? { codexReset: this.codexReset } : {}) };
  }

  record(ai: string, ev: UsageEvent, account = 'default'): void {
    if (this.closed) return;
    if (ev.type === 'tokens') {
      if (!ev.runId || !Number.isFinite(ev.count) || ev.count < 0 ||
          !Number.isFinite(ev.spanMs) || ev.spanMs <= 0 || !Number.isFinite(ev.at) ||
          !Number.isFinite(ev.at - ev.spanMs) || ev.at > this.now()) return;
      this.samples.set(ev.runId, { start: ev.at - ev.spanMs, end: ev.at, count: ev.count });
      this.tick();
      if (this.samples.size) {
        this.timer ??= setInterval(() => this.tick(), TICK_MS);
        this.timer.unref();
      }
      return;
    }
    const key = JSON.stringify([ai, account]);
    if (this.targets && !this.targets.has(key)) return;
    const current = this.items.get(key);
    // 並行回合可能比帳號查詢的資料舊，不能倒退。
    if (current?.quotaAt && Date.parse(ev.at) < Date.parse(current.quotaAt)) return;
    const resetCredits = ev.resetCredits ?? current?.resetCredits;
    const extraUsage = ev.extraUsage ?? current?.extraUsage;
    this.items.set(key, { ai, account, status: 'ready', windows: ev.windows, limited: ev.limited, quotaAt: ev.at, ...(ev.prepaidCents !== undefined ? { prepaidCents: ev.prepaidCents } : {}), ...(resetCredits ? { resetCredits } : {}), ...(extraUsage ? { extraUsage } : {}) });
    this.onChange(this.snapshot());
  }

  /** 實際 token 合計／實測區間的聯集：並行輸出可相加，先後完成不能相加各自的速度。 */
  rateAt(now: number): number | null {
    for (const [id, sample] of this.samples) if (sample.end <= now - RATE_WINDOW_MS) this.samples.delete(id);
    const samples = [...this.samples.values()].filter(sample => sample.end <= now).sort((a, b) => a.start - b.start);
    if (!samples.length) return null;
    let tokens = 0;
    let elapsed = 0;
    let end = -Infinity;
    for (const sample of samples) {
      tokens += sample.count;
      elapsed += Math.max(0, sample.end - Math.max(sample.start, end));
      end = Math.max(end, sample.end);
    }
    const rate = tokens / (elapsed / 1000);
    return Number.isFinite(rate) ? Math.round(rate * 10) / 10 : null;
  }

  /** 停止所有計時器（核心關閉或換工作區）。 */
  close(): void {
    this.closed = true;
    this.stopRate();
    this.samples.clear();
    this.rate = null;
    clearTimeout(this.pollTimer ?? undefined);
    this.pollTimer = null;
    clearTimeout(this.resetTimer ?? undefined);
    this.resetTimer = null;
  }

  private stopRate(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  /** 定時取得 Codex 重置排程；變動才推送。 */
  async pollCodexReset(fetchReset: () => Promise<string | null>, intervalMs: number): Promise<void> {
    if (this.closed) return;
    const next = (await fetchReset()) ?? undefined;
    if (this.closed) return;
    if (next !== this.codexReset) { this.codexReset = next; this.onChange(this.snapshot()); }
    this.resetTimer = setTimeout(() => { void this.pollCodexReset(fetchReset, intervalMs); }, intervalMs);
    this.resetTimer.unref();
  }

  /** 首次立即查詢；後續查詢完成後再計時，慢查詢不會堆疊。 */
  async poll(providers: Record<string, CliProvider>, intervalMs: number, accounts: () => Promise<Settings['accounts']> = async () => ({})): Promise<void> {
    if (this.closed) return;
    clearTimeout(this.pollTimer ?? undefined);
    try { await this.load(providers, await accounts()); }
    catch { log.warn('讀取帳戶設定失敗'); }
    if (this.closed) return;
    this.pollTimer = setTimeout(() => { void this.poll(providers, intervalMs, accounts); }, intervalMs);
    this.pollTimer.unref();
  }

  /** 同一帳戶的手動／定時查詢共用工作；刪除帳戶或關閉後的晚到回應不得復活舊資料。 */
  async load(providers: Record<string, CliProvider>, accounts: Settings['accounts'] = {}): Promise<void> {
    if (this.closed) return;
    const targets = Object.entries(providers).flatMap(([ai, provider]) => provider.quota
      ? [{ ai, provider, id: 'default', configDir: undefined as string | undefined },
        ...(accounts[ai] ?? []).map(account => ({ ai, provider, id: account.id, configDir: account.configDir }))]
      : []);
    this.targets = new Set(targets.map(target => JSON.stringify([target.ai, target.id])));
    let removed = false;
    for (const key of this.items.keys()) if (!this.targets.has(key)) { this.items.delete(key); removed = true; }
    if (removed) this.onChange(this.snapshot());
    await Promise.all(targets.map(({ ai, provider, id, configDir }) => {
      const key = JSON.stringify([ai, id]);
      const existing = this.queries.get(key);
      if (existing) return existing;
      const query = (async () => {
        try {
          const quota = await provider.quota!(configDir);
          if (quota) { this.record(ai, quota, id); return; }
        } catch {
          // 憑證錯誤與遠端回應可能含敏感資料，不記錄例外內容。
          log.warn('查詢帳戶額度失敗', { ai, account: id });
        }
        if (this.closed || !this.targets?.has(key)) return;
        const previous = this.items.get(key);
        this.items.set(key, previous ? { ...previous, status: 'unavailable' }
          : { ai, account: id, status: 'unavailable', windows: [], limited: false, quotaAt: null });
        this.onChange(this.snapshot());
      })().finally(() => { this.queries.delete(key); });
      this.queries.set(key, query);
      return query;
    }));
  }

  private tick(): void {
    const rate = this.rateAt(this.now());
    if (rate !== this.rate) {
      this.rate = rate;
      this.onChange(this.snapshot());
    }
    // 已無近期實測，停止閒置計時器。
    if (!this.samples.size && rate === null) this.stopRate();
  }
}
