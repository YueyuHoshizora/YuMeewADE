// Fenwick sums keep measurement and viewport lookup logarithmic during streaming.
export class HeightWindow {
  private heights: number[] = [];
  private tree = new Float64Array(1);
  get length(): number { return this.heights.length; }
  get total(): number { return this.offset(this.length); }
  reset(heights: number[]): void {
    this.heights = [...heights];
    let capacity = 1;
    while (capacity < heights.length) capacity *= 2;
    this.tree = new Float64Array(capacity + 1);
    heights.forEach((height, index) => this.add(index, height));
  }
  private add(index: number, delta: number): void {
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i]! += delta;
  }
  append(height: number): void {
    if (this.length + 1 >= this.tree.length) { this.reset([...this.heights, height]); return; }
    this.heights.push(height);
    this.add(this.length - 1, height);
  }
  prepend(heights: number[]): number {
    this.reset([...heights, ...this.heights]);
    return heights.reduce((sum, height) => sum + height, 0);
  }
  update(index: number, height: number): number {
    if (!Number.isFinite(height) || height <= 0 || index < 0 || index >= this.length) return 0;
    const delta = height - this.heights[index]!;
    this.heights[index] = height;
    this.add(index, delta);
    return delta;
  }
  offset(end: number): number {
    let sum = 0;
    for (let i = Math.min(this.length, Math.max(0, end)); i > 0; i -= i & -i) sum += this.tree[i]!;
    return sum;
  }
  indexAt(offset: number): number {
    let index = 0;
    let sum = 0;
    let step = (this.tree.length - 1) / 2;
    // Include the full capacity bit, including single-row windows.
    step = Math.max(1, step * 2);
    for (; step >= 1; step /= 2) {
      const next = index + step;
      if (next < this.tree.length && next <= this.length && sum + this.tree[next]! <= offset) {
        index = next;
        sum += this.tree[next]!;
      }
    }
    return Math.min(index, Math.max(0, this.length - 1));
  }
  range(top: number, viewport: number, overscan = 600): { start: number; end: number } {
    if (!this.length) return { start: 0, end: 0 };
    return { start: this.indexAt(Math.max(0, top - overscan)), end: Math.min(this.length, this.indexAt(top + viewport + overscan) + 1) };
  }
}

export interface WindowRow { key: number; render: () => HTMLElement }

/** Only visible cards are retained; measurements and disclosure state survive eviction. */
export class TranscriptWindow {
  private model = new HeightWindow();
  private rows: WindowRow[] = [];
  private indices = new Map<number, number>();
  private mounted = new Map<number, HTMLElement>();
  private expanded = new Map<number, boolean>();
  private top = document.createElement('div');
  private bottom = document.createElement('div');
  private frame = 0;
  private observer: ResizeObserver;
  private viewport: HTMLElement;
  private host: HTMLElement;
  private follows: () => boolean;
  constructor(viewport: HTMLElement, host: HTMLElement, follows: () => boolean) {
    this.viewport = viewport;
    this.host = host;
    this.follows = follows;
    this.top.setAttribute('aria-hidden', 'true');
    this.bottom.setAttribute('aria-hidden', 'true');
    host.append(this.top, this.bottom);
    this.observer = new ResizeObserver(() => this.measure());
    viewport.addEventListener('scroll', this.schedule);
    this.observer.observe(viewport);
    host.style.overflowAnchor = 'none';
  }
  private schedule = (): void => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  };
  reset(rows: WindowRow[]): void {
    for (const node of this.mounted.values()) { this.observer.unobserve(node); node.remove(); }
    this.mounted.clear();
    this.indices = new Map(rows.map((row, index) => [row.key, index]));
    this.expanded.clear();
    this.rows = rows;
    this.model.reset(rows.map(() => 180));
    this.render();
  }
  append(row: WindowRow): void {
    this.indices.set(row.key, this.rows.length);
    this.rows.push(row); this.model.append(180); this.render();
  }
  replace(row: WindowRow): void {
    const index = this.indices.get(row.key);
    if (index === undefined) return;
    this.rows[index] = row;
    const node = this.mounted.get(row.key);
    if (node) {
      const details = node.querySelector('details');
      if (details) this.expanded.set(row.key, details.open);
      this.observer.unobserve(node); node.remove(); this.mounted.delete(row.key);
    }
    this.render();
  }
  prepend(rows: WindowRow[]): void {
    const shift = this.model.prepend(rows.map(() => 180));
    this.rows.unshift(...rows);
    this.indices = new Map(this.rows.map((row, index) => [row.key, index]));
    this.viewport.scrollTop += shift;
    this.render();
  }
  reveal(key: number): void {
    const index = this.indices.get(key) ?? -1;
    if (index < 0) return;
    this.viewport.scrollTop += this.host.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top + this.model.offset(index);
    this.render();
  }
  refresh(): void { this.render(); }
  private render(): void {
    const top = this.viewport.scrollTop - (this.host.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top + this.viewport.scrollTop);
    const range = this.model.range(top, this.viewport.clientHeight);
    for (const [key, node] of this.mounted) {
      const index = this.indices.get(key) ?? -1;
      if ((index < range.start || index >= range.end) && !node.contains(document.activeElement)) {
        const details = node.querySelector('details');
        if (details) this.expanded.set(key, details.open);
        this.observer.unobserve(node); node.remove(); this.mounted.delete(key);
      }
    }
    this.top.style.height = `${this.model.offset(range.start)}px`;
    this.bottom.style.height = `${this.model.total - this.model.offset(range.end)}px`;
    for (let index = range.start; index < range.end; index++) {
      const row = this.rows[index]!;
      let node = this.mounted.get(row.key);
      if (!node) {
        node = row.render();
        node.dataset['windowKey'] = String(row.key);
        node.tabIndex = 0;
        this.mounted.set(row.key, node);
        const details = node.querySelector('details');
        if (details && this.expanded.has(row.key)) details.open = this.expanded.get(row.key)!;
        node.onkeydown = event => {
          if (event.target !== node || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          const at = this.indices.get(row.key)!;
          const next = this.rows[at + (event.key === 'ArrowUp' ? -1 : 1)];
          if (!next) return;
          event.preventDefault();
          this.reveal(next.key);
          this.mounted.get(next.key)?.focus();
        };
        this.observer.observe(node);
      }
      const previous = index === range.start ? this.top : this.mounted.get(this.rows[index - 1]!.key)!;
      if (previous.nextSibling !== node) this.host.insertBefore(node, previous.nextSibling);
    }
    this.measure();
  }
  private measure(): void {
    const anchor = this.model.indexAt(Math.max(0, this.viewport.getBoundingClientRect().top - this.host.getBoundingClientRect().top));
    let shift = 0;
    let changed = false;
    for (const [key, node] of this.mounted) {
      const index = this.indices.get(key) ?? -1;
      const height = node.getBoundingClientRect().height;
      if (index < 0 || height <= 0) continue;
      const delta = this.model.update(index, height);
      if (delta) { changed = true; if (index < anchor) shift += delta; }
    }
    if (!changed) return;
    if (this.follows()) this.viewport.scrollTop = this.viewport.scrollHeight;
    else this.viewport.scrollTop += shift;
    this.schedule();
  }
  dispose(): void { cancelAnimationFrame(this.frame); this.observer.disconnect(); this.viewport.removeEventListener('scroll', this.schedule); }
}
