import { TerminalBuffer } from './terminal-buffer.ts';
import { terminalLinkAt, type TerminalLink } from './terminal-links.ts';

/** Text-only VT renderer. Scrollback is selectable; alternate screens never enter history. */
export class TerminalScreen extends TerminalBuffer {
  readonly node: HTMLPreElement;
  private readonly selectionChanged: () => void;
  private rendered: string[] = [];
  constructor(cols: number, rows: number, label: string) {
    super(cols, rows);
    this.node = document.createElement('pre'); this.node.className = 'embedded-terminal-screen'; this.node.tabIndex = 0;
    this.node.setAttribute('role', 'textbox'); this.node.setAttribute('aria-label', label);
    this.node.style.cssText = 'background:#1d1f21;color:#c5c8c6;font:14px/18px monospace;margin:0;padding:8px;overflow:auto;height:432px;white-space:pre;user-select:text';
    this.selectionChanged = () => this.render();
    document.addEventListener('selectionchange', this.selectionChanged);
    this.render();
  }
  dispose(): void { document.removeEventListener('selectionchange', this.selectionChanged); }
  override resize(cols: number, rows: number): void { super.resize(cols, rows); this.node.style.height = `${this.rows * 18}px`; this.render(); }
  override write(text: string): void { super.write(text); this.render(); }
  /** The link under a viewport point, read from the rendered line so scrollback is included. */
  linkAt(x: number, y: number): TerminalLink | undefined {
    const caret = document.caretPositionFromPoint(x, y);
    const text = caret?.offsetNode;
    if (!text || text.nodeType !== Node.TEXT_NODE) return undefined;
    const cell = text.parentElement; const line = cell?.parentElement;
    if (!cell || !line || line.parentElement !== this.node) return undefined;
    let column = caret.offset;
    for (let node = cell.previousSibling; node; node = node.previousSibling) column += node.textContent?.length ?? 0;
    // Rows are padded to the full width, so a row ending in a non-space filled it and most likely soft-wrapped onto the next.
    const full = (row: Element | null): row is Element => !!row && /\S$/.test(row.textContent ?? '');
    let joined = line.textContent ?? '';
    for (let row = line.previousElementSibling, n = 0; full(row) && n < 16; row = row.previousElementSibling, n++) { const before = row.textContent ?? ''; joined = before + joined; column += before.length; }
    for (let row: Element | null = line, n = 0; full(row) && row.nextElementSibling && n < 16; row = row.nextElementSibling, n++) joined += row.nextElementSibling.textContent ?? '';
    return terminalLinkAt(joined, column);
  }
  private render(): void {
    // Do not destroy an active native selection while the shell continues producing output.
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && (this.node.contains(selection.anchorNode) || this.node.contains(selection.focusNode))) return;
    const follow = this.node.scrollHeight - this.node.scrollTop - this.node.clientHeight < 36;
    const lines = this.alternate ? this.grid : [...this.history, ...this.grid];
    const historyLength = this.alternate ? 0 : this.history.length;
    for (let y = 0; y < lines.length; y++) {
      const cells = lines[y]!;
      const signature = JSON.stringify(cells) + (this.cursor && y - historyLength === this.y ? `:${this.x}` : '');
      if (this.rendered[y] === signature) continue;
      const line = document.createElement('span'); line.style.display = 'block';
      let span: HTMLSpanElement | undefined; let previous = ''; let content = '';
      for (let x = 0; x < cells.length; x++) {
        const cell = cells[x]!;
        if (cell.width === 0) continue;
        const cursor = this.cursor && y - historyLength === this.y && (x === this.x || cell.width === 2 && x + 1 === this.x);
        const inverse = cell.inverse !== cursor; const fg = inverse ? cell.bg || '#1d1f21' : cell.fg; const bg = inverse ? cell.fg || '#c5c8c6' : cell.bg;
        const style = `${fg}|${bg}|${cell.bold}|${cell.underline}|${cell.width}`;
        if (!span || style !== previous || cell.width === 2) {
          if (span) span.textContent = content;
          content = ''; span = document.createElement('span');
          if (fg) span.style.color = fg; if (bg) span.style.backgroundColor = bg;
          if (cell.bold) span.style.fontWeight = 'bold'; if (cell.underline) span.style.textDecoration = 'underline';
          if (cell.width === 2) { span.style.display = 'inline-block'; span.style.width = '2ch'; }
          line.append(span); previous = style;
        }
        content += cell.char;
      }
      if (span) span.textContent = content;
      if (this.node.children[y]) this.node.children[y]!.replaceWith(line); else this.node.append(line);
      this.rendered[y] = signature;
    }
    while (this.node.children.length > lines.length) this.node.lastElementChild!.remove();
    this.rendered.length = lines.length;
    if (follow || this.alternate) this.node.scrollTop = this.node.scrollHeight;
  }
}
