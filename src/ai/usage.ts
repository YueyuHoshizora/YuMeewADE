// 各 AI 帳號額度與即時輸出速度：只在記憶體，來源是 CLI 的回報（Codex 另可從本機紀錄補啟動時的額度）。
import type { CliEvent, CliProvider } from '../cli/provider.ts';
import { log } from '../shared/log.ts';
import type { AiUsage, UsageState } from '../shared/types.ts';

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
  private closed = false;

  constructor(onChange: (usage: UsageState) => void, now: () => number = Date.now) {
    this.onChange = onChange;
    this.now = now;
  }

  snapshot(): UsageState {
    return { ais: [...this.items.values()].sort((a, b) => a.ai.localeCompare(b.ai)), tokensPerSecond: this.rate };
  }

  record(ai: string, ev: UsageEvent): void {
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
    const current = this.items.get(ai);
    // 並行回合或啟動時讀的本機紀錄可能比已知的舊，不能倒退。
    if (current?.quotaAt && Date.parse(ev.at) < Date.parse(current.quotaAt)) return;
    this.items.set(ai, { ai, windows: ev.windows, limited: ev.limited, quotaAt: ev.at });
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
    clearInterval(this.pollTimer ?? undefined);
    this.pollTimer = null;
  }

  private stopRate(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  /** 啟動時讀一次，之後固定間隔向各 CLI 重新查詢；額度在終端機或其他裝置上也會變，不能只靠本程式送出的回合。 */
  async poll(providers: Record<string, CliProvider>, intervalMs: number): Promise<void> {
    this.pollTimer ??= setInterval(() => { void this.load(providers); }, intervalMs);
    this.pollTimer.unref();
    await this.load(providers);
  }

  /** 啟動時從各 CLI 的本機紀錄補最近一次額度；讀不到只記日誌。 */
  async load(providers: Record<string, CliProvider>): Promise<void> {
    await Promise.all(Object.entries(providers).map(async ([ai, provider]) => {
      if (!provider.quota) return;
      try {
        const quota = await provider.quota();
        if (quota) this.record(ai, quota);
      } catch (err) {
        log.warn('讀取 CLI 額度紀錄失敗', { ai, reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
      }
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
