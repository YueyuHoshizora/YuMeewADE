interface Cell { char: string; fg: string; bg: string; bold: boolean; inverse: boolean }
const COLORS = ['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6', '#666666', '#d54e53', '#b9ca4a', '#e7c547', '#7aa6da', '#c397d8', '#70c0b1', '#ffffff'];
const blank = (): Cell => ({ char: ' ', fg: '', bg: '', bold: false, inverse: false });
function color(index: number): string {
  if (index < 16) return COLORS[index] ?? '';
  if (index > 231) { const gray = 8 + (index - 232) * 10; return `rgb(${gray},${gray},${gray})`; }
  const value = index - 16; const channel = (n: number) => n === 0 ? 0 : 55 + n * 40;
  return `rgb(${channel(Math.floor(value / 36))},${channel(Math.floor(value / 6) % 6)},${channel(value % 6)})`;
}

/** Bounded VT screen, not HTML output: escape sequences can never create links or executable markup. */
export class TerminalScreen {
  readonly node: HTMLPreElement;
  cols: number; rows: number;
  private grid: Cell[][];
  private alternate: Cell[][] | undefined;
  private x = 0; private y = 0; private savedX = 0; private savedY = 0;
  private top = 0; private bottom: number;
  private fg = ''; private bg = ''; private bold = false; private inverse = false;
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' | 'charset' = 'text';
  private sequence = '';
  private wrap = false;
  applicationCursor = false;
  bracketedPaste = false;
  onReply: ((text: string) => void) | undefined;
  private cursor = true;
  constructor(cols: number, rows: number, label: string) {
    this.cols = cols; this.rows = rows; this.bottom = rows - 1;
    this.grid = Array.from({ length: rows }, () => Array.from({ length: cols }, blank));
    this.node = document.createElement('pre'); this.node.className = 'embedded-terminal-screen'; this.node.tabIndex = 0;
    this.node.setAttribute('role', 'textbox'); this.node.setAttribute('aria-label', label);
    this.node.style.cssText = 'background:#1d1f21;color:#c5c8c6;font:14px/18px monospace;margin:0;padding:8px;overflow:hidden;min-height:180px;white-space:pre;user-select:text';
    this.render();
  }
  resize(cols: number, rows: number): void {
    this.cols = cols; this.rows = rows; this.bottom = rows - 1; this.top = 0;
    this.grid = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => this.grid[y]?.[x] ?? blank()));
    if (this.alternate) this.alternate = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => this.alternate?.[y]?.[x] ?? blank()));
    this.x = Math.min(this.x, cols - 1); this.y = Math.min(this.y, rows - 1); this.wrap = false; this.render();
  }
  write(text: string): void {
    for (const char of text) {
      if (this.state === 'osc') { if (char === '\x07') this.state = 'text'; else if (char === '\x1b') this.state = 'oscEscape'; continue; }
      if (this.state === 'oscEscape') { this.state = char === '\\' ? 'text' : 'osc'; continue; }
      if (this.state === 'charset') { this.state = 'text'; continue; }
      if (this.state === 'escape') {
        this.state = 'text';
        if (char === '[') { this.state = 'csi'; this.sequence = ''; }
        else if (char === ']') this.state = 'osc';
        else if (char === '(' || char === ')') this.state = 'charset';
        else if (char === '7') { this.savedX = this.x; this.savedY = this.y; }
        else if (char === '8') { this.x = Math.min(this.savedX, this.cols - 1); this.y = Math.min(this.savedY, this.rows - 1); }
        else if (char === 'D') this.linefeed();
        else if (char === 'E') { this.x = 0; this.linefeed(); }
        else if (char === 'M') { if (this.y === this.top) { this.grid.splice(this.bottom, 1); this.grid.splice(this.top, 0, Array.from({ length: this.cols }, blank)); } else this.y = Math.max(0, this.y - 1); }
        else if (char === 'c') { this.grid = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, blank)); this.x = 0; this.y = 0; this.fg = ''; this.bg = ''; this.bold = false; this.inverse = false; }
        continue;
      }
      if (this.state === 'csi') {
        if (/[@-~]/u.test(char)) { this.control(char, this.sequence); this.state = 'text'; }
        else if (this.sequence.length < 128) this.sequence += char; else this.state = 'text';
        continue;
      }
      if (char === '\x1b') { this.state = 'escape'; continue; }
      if (char === '\r') { this.x = 0; this.wrap = false; continue; }
      if (char === '\n' || char === '\v' || char === '\f') { this.linefeed(); continue; }
      if (char === '\b') { this.x = Math.max(0, this.x - 1); this.wrap = false; continue; }
      if (char === '\t') { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); continue; }
      if (char < ' ' || char === '\x7f') continue;
      const point = char.codePointAt(0)!;
      if (/\p{Mark}/u.test(char) && this.x > 0) { const cell = this.grid[this.y]![this.x - 1]!; if (cell.char.length < 16) cell.char += char; continue; }
      const width = point >= 0x1100 && (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff00 && point <= 0xff60 || point >= 0x1f300) ? 2 : 1;
      if (this.wrap || this.x + width > this.cols) { this.x = 0; this.linefeed(); this.wrap = false; }
      this.grid[this.y]![this.x] = { char, fg: this.fg, bg: this.bg, bold: this.bold, inverse: this.inverse };
      if (width === 2 && this.x + 1 < this.cols) this.grid[this.y]![this.x + 1] = { ...blank(), char: '' };
      this.x += width; if (this.x >= this.cols) { this.x = this.cols - 1; this.wrap = true; }
    }
    this.render();
  }
  private linefeed(): void {
    this.wrap = false;
    if (this.y === this.bottom) { this.grid.splice(this.top, 1); this.grid.splice(this.bottom, 0, Array.from({ length: this.cols }, blank)); }
    else this.y = Math.min(this.rows - 1, this.y + 1);
  }
  private control(command: string, sequence: string): void {
    const privateMode = sequence.startsWith('?'); const args = sequence.replace(/^\?/u, '').split(';').map(v => Number(v) || 0); const n = Math.max(1, args[0] ?? 0);
    this.wrap = false;
    if (command === 'n') { if (n === 6) this.onReply?.(`\x1b[${this.y + 1};${this.x + 1}R`); else if (n === 5) this.onReply?.('\x1b[0n'); return; }
    if (command === 'c') { this.onReply?.('\x1b[?1;2c'); return; }
    if (privateMode && (command === 'h' || command === 'l')) {
      for (const mode of args) {
        if (mode === 1) this.applicationCursor = command === 'h';
        if (mode === 2004) this.bracketedPaste = command === 'h';
        if (mode === 25) this.cursor = command === 'h';
        if (mode === 1049 || mode === 47 || mode === 1047) {
          if (command === 'h' && !this.alternate) { this.alternate = this.grid; this.savedX = this.x; this.savedY = this.y; this.grid = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, blank)); this.x = 0; this.y = 0; }
          if (command === 'l' && this.alternate) { this.grid = this.alternate; this.alternate = undefined; this.x = Math.min(this.savedX, this.cols - 1); this.y = Math.min(this.savedY, this.rows - 1); }
        }
      }
      return;
    }
    if (command === 'A') this.y = Math.max(0, this.y - n);
    else if (command === 'B' || command === 'e') this.y = Math.min(this.rows - 1, this.y + n);
    else if (command === 'C' || command === 'a') this.x = Math.min(this.cols - 1, this.x + n);
    else if (command === 'D') this.x = Math.max(0, this.x - n);
    else if (command === 'E') { this.y = Math.min(this.rows - 1, this.y + n); this.x = 0; }
    else if (command === 'F') { this.y = Math.max(0, this.y - n); this.x = 0; }
    else if (command === 'G' || command === '`') this.x = Math.min(this.cols - 1, n - 1);
    else if (command === 'd') this.y = Math.min(this.rows - 1, n - 1);
    else if (command === 'H' || command === 'f') { this.y = Math.min(this.rows - 1, n - 1); this.x = Math.min(this.cols - 1, Math.max(1, args[1] ?? 1) - 1); }
    else if (command === 's') { this.savedX = this.x; this.savedY = this.y; }
    else if (command === 'u') { this.x = Math.min(this.savedX, this.cols - 1); this.y = Math.min(this.savedY, this.rows - 1); }
    else if (command === 'r') { this.top = Math.min(this.rows - 1, n - 1); this.bottom = Math.min(this.rows - 1, Math.max(this.top + 1, (args[1] || this.rows) - 1)); this.x = 0; this.y = this.top; }
    else if (command === 'J') {
      const mode = args[0] ?? 0;
      for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) if (mode === 2 || mode === 3 || mode === 0 && (y > this.y || y === this.y && x >= this.x) || mode === 1 && (y < this.y || y === this.y && x <= this.x)) this.grid[y]![x] = blank();
    } else if (command === 'K') { const mode = args[0] ?? 0; for (let x = 0; x < this.cols; x++) if (mode === 2 || mode === 0 && x >= this.x || mode === 1 && x <= this.x) this.grid[this.y]![x] = blank(); }
    else if (command === 'P') { this.grid[this.y]!.splice(this.x, Math.min(n, this.cols - this.x)); while (this.grid[this.y]!.length < this.cols) this.grid[this.y]!.push(blank()); }
    else if (command === '@') { this.grid[this.y]!.splice(this.x, 0, ...Array.from({ length: Math.min(n, this.cols) }, blank)); this.grid[this.y]!.length = this.cols; }
    else if (command === 'X') { for (let x = this.x; x < Math.min(this.cols, this.x + n); x++) this.grid[this.y]![x] = blank(); }
    else if (command === 'L' || command === 'M') { if (this.y >= this.top && this.y <= this.bottom) for (let i = 0; i < Math.min(n, this.rows); i++) { if (command === 'L') { this.grid.splice(this.bottom, 1); this.grid.splice(this.y, 0, Array.from({ length: this.cols }, blank)); } else { this.grid.splice(this.y, 1); this.grid.splice(this.bottom, 0, Array.from({ length: this.cols }, blank)); } } }
    else if (command === 'S' || command === 'T') { for (let i = 0; i < Math.min(n, this.rows); i++) { this.grid.splice(command === 'S' ? this.top : this.bottom, 1); this.grid.splice(command === 'S' ? this.bottom : this.top, 0, Array.from({ length: this.cols }, blank)); } }
    else if (command === 'm') {
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === 0) { this.fg = ''; this.bg = ''; this.bold = false; this.inverse = false; }
        else if (a === 1) this.bold = true; else if (a === 22) this.bold = false;
        else if (a === 7) this.inverse = true; else if (a === 27) this.inverse = false;
        else if (a === 39) this.fg = ''; else if (a === 49) this.bg = '';
        else if (a >= 30 && a <= 37) this.fg = color(a - 30); else if (a >= 40 && a <= 47) this.bg = color(a - 40);
        else if (a >= 90 && a <= 97) this.fg = color(a - 90 + 8); else if (a >= 100 && a <= 107) this.bg = color(a - 100 + 8);
        else if (a === 38 || a === 48) {
          let c = ''; if (args[i + 1] === 5) { c = color(Math.min(255, Math.max(0, args[i + 2] ?? 0))); i += 2; }
          else if (args[i + 1] === 2) { c = `rgb(${args.slice(i + 2, i + 5).map(v => Math.min(255, Math.max(0, v))).join(',')})`; i += 4; }
          if (a === 38) this.fg = c; else this.bg = c;
        }
      }
    }
  }
  private render(): void {
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < this.rows; y++) {
      let span: HTMLSpanElement | undefined; let previous = ''; let content = '';
      for (let x = 0; x < this.cols; x++) {
        const c = this.grid[y]?.[x] ?? blank(); const cursor = this.cursor && x === this.x && y === this.y;
        const inverse = c.inverse !== cursor; const fg = inverse ? c.bg || '#1d1f21' : c.fg; const bg = inverse ? c.fg || '#c5c8c6' : c.bg;
        const style = `${fg}|${bg}|${c.bold}`;
        if (!span || style !== previous) { if (span) span.textContent = content; content = ''; span = document.createElement('span'); if (fg) span.style.color = fg; if (bg) span.style.backgroundColor = bg; if (c.bold) span.style.fontWeight = 'bold'; fragment.append(span); previous = style; }
        content += c.char;
      }
      if (span) span.textContent = content;
      if (y < this.rows - 1) fragment.append(document.createTextNode('\n'));
    }
    this.node.replaceChildren(fragment);
  }
}
