export interface TerminalCell { char: string; width: number; fg: string; bg: string; bold: boolean; inverse: boolean; underline: boolean }
/** DECSC state: cursor, rendition, origin mode, pending wrap, autowrap and the G0/G1 designations with the shift state. */
interface Position { x: number; y: number; fg: string; bg: string; bold: boolean; inverse: boolean; underline: boolean; origin: boolean; wrap: boolean; autowrap: boolean; charset: boolean; g0: boolean; g1: boolean }
const COLORS = ['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6', '#666666', '#d54e53', '#b9ca4a', '#e7c547', '#7aa6da', '#c397d8', '#70c0b1', '#ffffff'];
const DEC = '◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function width(text: string): number {
  const point = text.codePointAt(0)!;
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(text)) return 2;
  return point >= 0x1100 && (point <= 0x115f || point >= 0x2329 && point <= 0x232a || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6 || point >= 0x20000 && point <= 0x3ffff) ? 2 : 1;
}
function color(index: number): string {
  if (index < 16) return COLORS[index] ?? '';
  if (index > 231) { const gray = 8 + (index - 232) * 10; return `rgb(${gray},${gray},${gray})`; }
  const value = index - 16; const channel = (n: number) => n === 0 ? 0 : 55 + n * 40;
  return `rgb(${channel(Math.floor(value / 36))},${channel(Math.floor(value / 6) % 6)},${channel(value % 6)})`;
}

/** Deliberately bounded VT subset. OSC/DCS are discarded, never interpreted as clipboard or links. */
export class TerminalBuffer {
  cols: number; rows: number; grid: TerminalCell[][]; history: TerminalCell[][] = [];
  x = 0; y = 0; cursor = true; applicationCursor = false; bracketedPaste = false;
  onReply: ((text: string) => void) | undefined;
  private primary: { grid: TerminalCell[][]; position: Position; saved: Position | undefined; top: number; bottom: number } | undefined;
  private saved: Position | undefined;
  private top = 0; private bottom: number; private origin = false; private autowrap = true; private insert = false;
  private fg = ''; private bg = ''; private bold = false; private inverse = false; private underline = false;
  private wrap = false; private charset = false; private charsetTarget = '('; private g0 = false; private g1 = false;
  private tabs = new Set<number>();
  private state: 'text' | 'escape' | 'csi' | 'discardCsi' | 'string' | 'stringEscape' | 'charset' = 'text';
  private osc = false;
  private sequence = ''; private surrogate = ''; private last: { x: number; y: number } | undefined;
  constructor(cols: number, rows: number) {
    this.cols = cols; this.rows = rows; this.bottom = rows - 1; this.grid = this.emptyGrid(); this.resetTabs();
  }
  get alternate(): boolean { return this.primary !== undefined; }
  private blank(): TerminalCell { return { char: ' ', width: 1, fg: this.fg, bg: this.bg, bold: false, inverse: false, underline: false }; }
  private line(): TerminalCell[] { return Array.from({ length: this.cols }, () => this.blank()); }
  private emptyGrid(): TerminalCell[][] { return Array.from({ length: this.rows }, () => this.line()); }
  private resetTabs(): void { this.tabs.clear(); for (let x = 8; x < this.cols; x += 8) this.tabs.add(x); }
  private position(): Position { return { x: this.x, y: this.y, fg: this.fg, bg: this.bg, bold: this.bold, inverse: this.inverse, underline: this.underline, origin: this.origin, wrap: this.wrap, autowrap: this.autowrap, charset: this.charset, g0: this.g0, g1: this.g1 }; }
  private restore(p: Position | undefined): void { if (p) { Object.assign(this, p); this.x = Math.min(this.cols - 1, this.x); this.y = Math.min(this.rows - 1, this.y); } }
  reset(): void {
    this.primary = undefined; this.saved = undefined; this.fg = ''; this.bg = ''; this.bold = false; this.inverse = false; this.underline = false;
    this.origin = false; this.autowrap = true; this.insert = false; this.wrap = false; this.charset = false; this.g0 = false; this.g1 = false;
    this.applicationCursor = false; this.bracketedPaste = false; this.cursor = true; this.x = 0; this.y = 0; this.top = 0; this.bottom = this.rows - 1;
    this.state = 'text'; this.sequence = ''; this.surrogate = ''; this.last = undefined; this.history = []; this.grid = this.emptyGrid(); this.resetTabs();
  }
  resize(cols: number, rows: number): void {
    cols = Math.max(2, Math.min(300, Math.trunc(cols))); rows = Math.max(2, Math.min(300, Math.trunc(rows)));
    const oldCols = this.cols; this.cols = cols; this.rows = rows;
    const resizeGrid = (grid: TerminalCell[][]) => Array.from({ length: rows }, (_, y) => {
      const line = Array.from({ length: cols }, (_, x) => grid[y]?.[x] ?? this.blank()); this.repair(line); return line;
    });
    this.grid = resizeGrid(this.grid); if (this.primary) this.primary.grid = resizeGrid(this.primary.grid);
    for (let x = Math.ceil(oldCols / 8) * 8; x < cols; x += 8) if (x) this.tabs.add(x);
    for (const x of this.tabs) if (x >= cols) this.tabs.delete(x);
    this.x = Math.min(this.x, cols - 1); this.y = Math.min(this.y, rows - 1); this.top = 0; this.bottom = rows - 1; this.wrap = false; this.last = undefined;
  }
  write(text: string): void {
    text = this.surrogate + text; this.surrogate = '';
    if (/[\uD800-\uDBFF]$/u.test(text)) { this.surrogate = text.slice(-1); text = text.slice(0, -1); }
    for (const char of text) {
      if (char === '\x18' || char === '\x1a') { this.state = 'text'; this.last = undefined; continue; }
      if (this.state === 'string') { if (char === '\x07' && this.osc || char === '\u009c') this.state = 'text'; else if (char === '\x1b') this.state = 'stringEscape'; continue; }
      if (this.state === 'stringEscape') { this.state = char === '\\' || char === '\u009c' || char === '\x07' && this.osc ? 'text' : char === '\x1b' ? 'stringEscape' : 'string'; continue; }
      if (char === '\x1b') { this.state = 'escape'; this.last = undefined; continue; }
      if (this.state === 'charset') { if (this.charsetTarget === '(') this.g0 = char === '0'; else this.g1 = char === '0'; this.charset = this.g0; this.state = 'text'; continue; }
      if (this.state === 'escape') {
        this.state = 'text';
        if (char === '[') { this.state = 'csi'; this.sequence = ''; }
        else if (']P^_X'.includes(char)) { this.state = 'string'; this.osc = char === ']'; }
        else if (char === '(' || char === ')') { this.charsetTarget = char; this.state = 'charset'; }
        else if (char === '7') this.saved = this.position(); else if (char === '8') this.restore(this.saved);
        else if (char === 'D') this.linefeed(); else if (char === 'E') { this.x = 0; this.linefeed(); }
        else if (char === 'M') { if (this.y === this.top) this.scroll(-1); else this.y = Math.max(0, this.y - 1); this.wrap = false; }
        else if (char === 'H') this.tabs.add(this.x); else if (char === 'c') this.reset();
        continue;
      }
      if (this.state === 'csi' || this.state === 'discardCsi') {
        if (/[@-~]/u.test(char)) { if (this.state === 'csi') this.control(char, this.sequence); this.state = 'text'; }
        else if (char >= ' ' && this.state === 'csi') { if (this.sequence.length < 128) this.sequence += char; else this.state = 'discardCsi'; }
        continue;
      }
      if (char === '\u009b') { this.state = 'csi'; this.sequence = ''; this.last = undefined; continue; }
      if (char === '\u009d' || char === '\u0090' || char === '\u009e' || char === '\u009f') { this.state = 'string'; this.osc = char === '\u009d'; this.last = undefined; continue; }
      if (char === '\r') { this.x = 0; this.wrap = false; this.last = undefined; continue; }
      if (char === '\n' || char === '\v' || char === '\f') { this.linefeed(); this.last = undefined; continue; }
      if (char === '\b') { this.x = Math.max(0, this.x - 1); this.wrap = false; this.last = undefined; continue; }
      if (char === '\t') { this.tab(1); this.last = undefined; continue; }
      if (char === '\x0e' || char === '\x0f') { this.charset = char === '\x0e' ? this.g1 : this.g0; continue; }
      if (char < ' ' || char >= '\x7f' && char <= '\x9f') continue;
      this.put(this.charset && char >= '`' && char <= '~' ? DEC[char.charCodeAt(0) - 96]! : char);
    }
  }
  private put(char: string): void {
    if (this.last) {
      const cell = this.grid[this.last.y]?.[this.last.x];
      const segments = cell && cell.char.length < 64 ? segmenter.segment(cell.char + char)[Symbol.iterator]() : undefined;
      segments?.next();
      if (cell && segments?.next().done) {
        const nextWidth = Math.min(this.cols, width(cell.char + char)); cell.char += char;
        if (nextWidth === 2 && cell.width === 1) {
          if (this.last.x + 1 >= this.cols) {
            this.eraseCell(this.grid[this.last.y]!, this.last.x);
            if (this.autowrap) { this.x = 0; this.linefeed(); } else this.x = this.cols - 2;
            this.last = { x: this.x, y: this.y };
            this.eraseCell(this.grid[this.y]!, this.x); this.grid[this.y]![this.x] = cell;
          }
          cell.width = 2;
          this.eraseCell(this.grid[this.last.y]!, this.last.x + 1);
          this.grid[this.last.y]![this.last.x + 1] = { ...this.blank(), char: '', width: 0 };
          this.x = Math.min(this.cols - 1, this.last.x + 2); this.wrap = this.autowrap && this.last.x + 2 >= this.cols;
        }
        return;
      }
    }
    if (/\p{Mark}|\u200d/u.test(char)) return;
    const size = width(char);
    if (this.wrap || this.x + size > this.cols) { if (this.autowrap) { this.x = 0; this.linefeed(); } else this.x = Math.max(0, this.cols - size); this.wrap = false; }
    const line = this.grid[this.y]!;
    if (this.insert) { line.splice(this.x, 0, ...Array.from({ length: size }, () => this.blank())); line.length = this.cols; }
    this.eraseCell(line, this.x); if (size === 2) this.eraseCell(line, this.x + 1);
    line[this.x] = { char, width: size, fg: this.fg, bg: this.bg, bold: this.bold, inverse: this.inverse, underline: this.underline };
    if (size === 2) line[this.x + 1] = { ...this.blank(), char: '', width: 0 };
    this.last = { x: this.x, y: this.y }; this.x += size;
    if (this.x >= this.cols) { this.x = this.cols - 1; this.wrap = this.autowrap; }
    this.repair(line);
  }
  private eraseCell(line: TerminalCell[], x: number): void {
    if (x >= this.cols) return;
    if (line[x]?.width === 0 && x > 0) line[x - 1] = this.blank();
    if (line[x]?.width === 2 && x + 1 < this.cols) line[x + 1] = this.blank();
    line[x] = this.blank();
  }
  private repair(line: TerminalCell[]): void {
    for (let x = 0; x < line.length; x++) { if (line[x]!.width === 2 && line[x + 1]?.width !== 0 || line[x]!.width === 0 && line[x - 1]?.width !== 2) line[x] = this.blank(); }
  }
  private scroll(amount: number): void {
    for (let i = 0; i < Math.min(Math.abs(amount), this.bottom - this.top + 1); i++) {
      if (amount > 0) { const removed = this.grid.splice(this.top, 1)[0]!; if (!this.primary && this.top === 0 && this.bottom === this.rows - 1) { this.history.push(removed); if (this.history.length > 2000) this.history.shift(); } this.grid.splice(this.bottom, 0, this.line()); }
      else { this.grid.splice(this.bottom, 1); this.grid.splice(this.top, 0, this.line()); }
    }
  }
  private linefeed(): void { this.wrap = false; if (this.y === this.bottom) this.scroll(1); else this.y = Math.min(this.rows - 1, this.y + 1); }
  private tab(amount: number): void { for (let i = 0; i < Math.min(Math.abs(amount), this.cols); i++) { this.x = amount > 0 ? [...this.tabs].filter(x => x > this.x).sort((a, b) => a - b)[0] ?? this.cols - 1 : [...this.tabs].filter(x => x < this.x).sort((a, b) => b - a)[0] ?? 0; } this.wrap = false; }
  private control(command: string, sequence: string): void {
    this.last = undefined;
    if (sequence === '!' && command === 'p') { this.origin = false; this.insert = false; this.autowrap = true; this.top = 0; this.bottom = this.rows - 1; this.fg = ''; this.bg = ''; this.bold = false; this.inverse = false; this.underline = false; return; }
    if (!/^[?>]?[\d;]*$/u.test(sequence)) return;
    const privateMode = sequence.startsWith('?'); const secondary = sequence.startsWith('>'); const args = sequence.replace(/^[?>]/u, '').split(';').map(v => Math.min(65535, Number(v) || 0)); const n = Math.max(1, args[0] ?? 0);
    if (command === 'n') { if (n === 6) this.onReply?.(`\x1b[${privateMode ? '?' : ''}${this.y + 1 - (this.origin ? this.top : 0)};${this.x + 1}R`); else if (n === 5 && !privateMode) this.onReply?.('\x1b[0n'); return; }
    if (command === 'c') { if (!secondary && !privateMode && n === 1) this.onReply?.('\x1b[?1;2c'); return; }
    if (!['m', 'h', 'l', 's', 'u'].includes(command)) this.wrap = false;
    if (command === 'h' || command === 'l') {
      const enabled = command === 'h';
      for (const mode of args) {
        if (!privateMode) { if (mode === 4) this.insert = enabled; continue; }
        if (mode === 1) this.applicationCursor = enabled; else if (mode === 2004) this.bracketedPaste = enabled; else if (mode === 25) this.cursor = enabled;
        else if (mode === 6) { this.origin = enabled; this.x = 0; this.y = enabled ? this.top : 0; }
        else if (mode === 7) this.autowrap = enabled;
        else if (mode === 1048) { if (enabled) this.saved = this.position(); else this.restore(this.saved); }
        else if (mode === 1049 || mode === 47 || mode === 1047) {
          if (enabled && !this.primary) { this.primary = { grid: this.grid, position: this.position(), saved: this.saved, top: this.top, bottom: this.bottom }; this.grid = this.emptyGrid(); this.x = 0; this.y = 0; this.saved = undefined; this.wrap = false; this.top = 0; this.bottom = this.rows - 1; }
          else if (!enabled && this.primary) { const primary = this.primary; this.grid = primary.grid; this.saved = primary.saved; this.primary = undefined; this.restore(primary.position); this.top = Math.min(primary.top, this.rows - 2); this.bottom = Math.min(primary.bottom, this.rows - 1); }
        }
      }
      return;
    }
    if (privateMode || secondary) return;
    const low = this.origin ? this.top : 0; const high = this.origin ? this.bottom : this.rows - 1;
    if (command === 'A') this.y = Math.max(this.y >= this.top ? this.top : 0, this.y - n);
    else if (command === 'B' || command === 'e') this.y = Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + n);
    else if (command === 'C' || command === 'a') this.x = Math.min(this.cols - 1, this.x + n);
    else if (command === 'D') this.x = Math.max(0, this.x - n);
    // CNL/CPL are CUD/CUU plus carriage return, so they stop at the scrolling margins the same way.
    else if (command === 'E') { this.y = Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + n); this.x = 0; }
    else if (command === 'F') { this.y = Math.max(this.y >= this.top ? this.top : 0, this.y - n); this.x = 0; }
    else if (command === 'G' || command === '`') this.x = Math.min(this.cols - 1, n - 1);
    else if (command === 'd') this.y = Math.min(high, low + n - 1);
    else if (command === 'H' || command === 'f') { this.y = Math.min(high, low + n - 1); this.x = Math.min(this.cols - 1, Math.max(1, args[1] ?? 1) - 1); }
    else if (command === 's') this.saved = this.position(); else if (command === 'u') this.restore(this.saved);
    else if (command === 'r') { const top = n - 1; const bottom = (args[1] || this.rows) - 1; if (top < bottom && bottom < this.rows) { this.top = top; this.bottom = bottom; this.x = 0; this.y = this.origin ? top : 0; } }
    else if (command === 'I') this.tab(n); else if (command === 'Z') this.tab(-n);
    else if (command === 'g') { if (args[0] === 0) this.tabs.delete(this.x); else if (args[0] === 3) this.tabs.clear(); }
    else if (command === 'J' || command === 'K' || command === 'X') {
      const mode = args[0] ?? 0;
      if (command === 'J' && mode === 3) { this.history = []; return; }
      for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
        const erase = command === 'X' ? y === this.y && x >= this.x && x < this.x + n : command === 'K' ? y === this.y && (mode === 2 || mode === 0 && x >= this.x || mode === 1 && x <= this.x) : mode === 2 || mode === 0 && (y > this.y || y === this.y && x >= this.x) || mode === 1 && (y < this.y || y === this.y && x <= this.x);
        if (erase) this.eraseCell(this.grid[y]!, x);
      }
    } else if (command === 'P' || command === '@') {
      const line = this.grid[this.y]!; const count = Math.min(n, this.cols - this.x);
      if (command === 'P') { line.splice(this.x, count); while (line.length < this.cols) line.push(this.blank()); }
      else { line.splice(this.x, 0, ...Array.from({ length: count }, () => this.blank())); line.length = this.cols; }
      this.repair(line);
    } else if (command === 'L' || command === 'M') {
      if (this.y >= this.top && this.y <= this.bottom) for (let i = 0; i < Math.min(n, this.bottom - this.y + 1); i++) { if (command === 'L') { this.grid.splice(this.bottom, 1); this.grid.splice(this.y, 0, this.line()); } else { this.grid.splice(this.y, 1); this.grid.splice(this.bottom, 0, this.line()); } }
    } else if (command === 'S' || command === 'T') this.scroll(command === 'S' ? n : -n);
    else if (command === 'm') {
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === 0) { this.fg = ''; this.bg = ''; this.bold = false; this.inverse = false; this.underline = false; }
        else if (a === 1) this.bold = true; else if (a === 22) this.bold = false; else if (a === 4) this.underline = true; else if (a === 24) this.underline = false;
        else if (a === 7) this.inverse = true; else if (a === 27) this.inverse = false;
        else if (a === 39) this.fg = ''; else if (a === 49) this.bg = '';
        else if (a >= 30 && a <= 37) this.fg = color(a - 30); else if (a >= 40 && a <= 47) this.bg = color(a - 40);
        else if (a >= 90 && a <= 97) this.fg = color(a - 90 + 8); else if (a >= 100 && a <= 107) this.bg = color(a - 100 + 8);
        else if (a === 38 || a === 48) {
          let c = ''; if (args[i + 1] === 5 && args[i + 2] !== undefined) { c = color(Math.min(255, args[i + 2]!)); i += 2; }
          else if (args[i + 1] === 2 && args[i + 4] !== undefined) { c = `rgb(${args.slice(i + 2, i + 5).map(v => Math.min(255, v)).join(',')})`; i += 4; }
          if (c) { if (a === 38) this.fg = c; else this.bg = c; }
        }
      }
    }
  }
}
