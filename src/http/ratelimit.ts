// 每來源每分鐘次數上限（滑動視窗）。只用在送出指示，防誤觸狂送。

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private nextPrune = 0;

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** 回 true 代表允許並計入；false 代表超限。 */
  take(key: string, now = Date.now()): boolean {
    if (now >= this.nextPrune) {
      const cutoff = now - this.windowMs;
      for (const [id, hits] of this.hits) {
        const live = hits.filter(t => t > cutoff);
        if (live.length) this.hits.set(id, live);
        else this.hits.delete(id);
      }
      this.nextPrune = now + this.windowMs;
    }
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      if (list.length) this.hits.set(key, list);
      else this.hits.delete(key);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}
