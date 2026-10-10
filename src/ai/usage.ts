// 各 AI 帳號額度與即時輸出速度：只在記憶體，來源是 CLI 的回報（Codex 另可從本機紀錄補啟動時的額度）。
import type { CliEvent, CliProvider } from '../cli/provider.ts';
import { log } from '../shared/log.ts';
import type { AiUsage, UsageState } from '../shared/types.ts';

export type UsageEvent = Extract<CliEvent, { type: 'quota' | 'tokens' }>;

/** tok/s 以最近這段時間的輸出量計算；Claude 的思考估算約 1.2 秒才更新一次，窗口太短數字會跟著跳。 */
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
  private samples: Sample[] = [];
  private rate = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(onChange: (usage: UsageState) => void, now: () => number = Date.now) {
    this.onChange = onChange;
    this.now = now;
  }

  snapshot(): UsageState {
    return { ais: [...this.items.values()].sort((a, b) => a.ai.localeCompare(b.ai)), tokensPerSecond: this.rate };
  }

  record(ai: string, ev: UsageEvent): void {
    if (ev.type === 'tokens') {
      const end = this.now();
      this.samples.push({ start: end - (ev.spanMs ?? 0), end, count: ev.count });
      this.timer ??= setInterval(() => this.tick(), TICK_MS);
      this.timer.unref();
      return;
    }
    const current = this.items.get(ai);
    // 並行回合或啟動時讀的本機紀錄可能比已知的舊，不能倒退。
    if (current?.quotaAt && Date.parse(ev.at) < Date.parse(current.quotaAt)) return;
    this.items.set(ai, { ai, windows: ev.windows, limited: ev.limited, quotaAt: ev.at });
    this.onChange(this.snapshot());
  }

  /** 最近 RATE_WINDOW_MS 內的輸出量換算成每秒；有時間跨度的樣本（校正量）只算落在窗口內的比例。 */
  rateAt(now: number): number {
    const from = now - RATE_WINDOW_MS;
    this.samples = this.samples.filter(s => s.end > from);
    let tokens = 0;
    for (const s of this.samples) {
      tokens += s.end === s.start ? s.count : s.count * (Math.min(s.end, now) - Math.max(s.start, from)) / (s.end - s.start);
    }
    // 估算偏高時的負校正不能讓速度變成負數。
    return Math.max(0, Math.round(tokens / (RATE_WINDOW_MS / 1000)));
  }

  /** 停止計時器（核心關閉或換工作區）。 */
  close(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
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
    // 窗口內已沒有樣本且已推送過 0：停表，閒置時不空轉。
    if (!this.samples.length && rate === 0) this.close();
  }
}
