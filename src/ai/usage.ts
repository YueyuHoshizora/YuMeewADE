// 各 AI 帳號額度與輸出速度：只在記憶體，來源是 CLI 每回合的回報（Codex 另可從本機紀錄補啟動時的值）。
import type { CliEvent, CliProvider } from '../cli/provider.ts';
import { log } from '../shared/log.ts';
import type { AiUsage } from '../shared/types.ts';

export type UsageEvent = Extract<CliEvent, { type: 'quota' | 'speed' }>;

export class UsageBoard {
  private readonly items = new Map<string, AiUsage>();
  private readonly onChange: (usage: AiUsage[]) => void;

  constructor(onChange: (usage: AiUsage[]) => void) {
    this.onChange = onChange;
  }

  list(): AiUsage[] {
    return [...this.items.values()].sort((a, b) => a.ai.localeCompare(b.ai));
  }

  record(ai: string, ev: UsageEvent, now: Date = new Date()): void {
    const current = this.items.get(ai) ?? { ai, windows: [], limited: false, quotaAt: null, tokensPerSecond: null, speedAt: null };
    let next: AiUsage;
    if (ev.type === 'quota') {
      // 並行回合或啟動時讀的本機紀錄可能比已知的舊，不能倒退。
      if (current.quotaAt && Date.parse(ev.at) < Date.parse(current.quotaAt)) return;
      next = { ...current, windows: ev.windows, limited: ev.limited, quotaAt: ev.at };
    } else {
      next = { ...current, tokensPerSecond: ev.tokensPerSecond, speedAt: now.toISOString() };
    }
    this.items.set(ai, next);
    this.onChange(this.list());
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
}
