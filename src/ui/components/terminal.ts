import type { TerminalLease, TerminalSession } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, field, input, row, run } from './dom.ts';
import { TerminalScreen } from './terminal-screen.ts';

export function embeddedTerminal(project: string, task: string): { node: HTMLElement; dispose: () => void } {
  const node = el('section', 'card'); const screen = new TerminalScreen(100, 24, t('tools.terminal'));
  const status = el('p'); const controls = row();
  const columns = input('100'); const lines = input('24');
  for (const control of [columns, lines]) { control.type = 'number'; control.min = '2'; control.max = '300'; }
  const receiver = el('textarea'); receiver.setAttribute('aria-label', t('tools.terminalInput')); receiver.autocapitalize = 'off'; receiver.spellcheck = false;
  receiver.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;overflow:hidden';
  let lease: TerminalLease | undefined; let alive = true; let timer: number | undefined; let after = 0; let inputQueue = ''; let sending = false;
  const identity = () => ({ project, task, id: lease!.session.id, owner: lease!.owner });
  async function flush(): Promise<void> {
    if (sending || !lease || !alive) return;
    sending = true;
    try { while (inputQueue && alive) { const text = inputQueue.slice(0, 16384); inputQueue = inputQueue.slice(16384); await request('/api/terminal/input', { ...identity(), text }); } }
    finally { sending = false; }
  }
  function send(text: string): void {
    if (!lease || lease.session.status !== 'running' || inputQueue.length + text.length > 65536) return;
    inputQueue += text; void run(flush);
  }
  screen.onReply = send;
  async function poll(): Promise<void> {
    if (!alive || !lease) return;
    try {
      const current = await request<TerminalSession>('/api/terminal/output', { ...identity(), after });
      if (!alive) return;
      if (current.output.length && current.output[0]!.sequence > after + 1) screen.write('\x1b[2J\x1b[H');
      if (current.output.length) screen.write(current.output.map(event => event.text).join(''));
      after = current.sequence; lease.session = current;
      status.textContent = `${t(current.status === 'running' ? 'tools.running' : 'tools.closed')}${current.truncated ? ' · ' + t('execution.truncated') : ''}`;
    } finally { if (alive && lease?.session.status === 'running') timer = window.setTimeout(() => { void run(poll); }, 100); }
  }
  const start = button(t('tools.terminal'), async () => {
    if (lease?.session.status === 'running') return;
    lease = await request<TerminalLease>('/api/terminal/start', { project, task, cols: screen.cols, rows: screen.rows });
    if (!alive) { await request('/api/terminal/stop', identity()); return; }
    after = 0; screen.write('\x1b[2J\x1b[H'); receiver.focus(); await poll();
  });
  controls.append(start, button(t('execution.stop'), async () => { if (lease) { await request('/api/terminal/stop', identity()); lease.session.status = 'stopped'; clearTimeout(timer); status.textContent = t('tools.closed'); } }));
  controls.append(field(t('tools.columns'), columns), field(t('tools.rows'), lines), button(t('tools.resize'), async () => {
    const cols = Number(columns.value); const rows = Number(lines.value);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 300 || rows < 2 || rows > 300) return;
    if (lease?.session.status === 'running') await request('/api/terminal/resize', { ...identity(), cols, rows });
    screen.resize(cols, rows);
  }));
  const keys: Record<string, string> = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', Delete: '\x1b[3~', Insert: '\x1b[2~', Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~', F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~', F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~' };
  receiver.addEventListener('keydown', event => {
    if (event.isComposing || event.metaKey || event.ctrlKey && event.shiftKey && (event.key === 'C' || event.key === 'V')) return;
    let value = keys[event.key];
    const arrows: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };
    if (arrows[event.key]) value = `\x1b${screen.applicationCursor ? 'O' : '['}${arrows[event.key]}`;
    if (event.shiftKey && event.key === 'Tab') value = '\x1b[Z';
    if (event.ctrlKey && event.key.length === 1) { const code = event.key.toUpperCase().charCodeAt(0); if (code >= 64 && code <= 95) value = String.fromCharCode(code - 64); else if (event.key === ' ') value = '\0'; }
    if (event.altKey && event.key.length === 1) value = '\x1b' + event.key;
    if (value !== undefined) { event.preventDefault(); send(value); }
  });
  receiver.addEventListener('input', () => { if (receiver.value) { send(receiver.value); receiver.value = ''; } });
  receiver.addEventListener('paste', event => { const text = event.clipboardData?.getData('text/plain'); if (text) { event.preventDefault(); send(screen.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text); } });
  screen.node.addEventListener('focus', () => receiver.focus()); screen.node.addEventListener('click', () => { if (!window.getSelection()?.toString()) receiver.focus(); });
  let resizeTimer: number | undefined;
  const observer = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width ?? 0;
    const cols = Math.min(300, Math.max(20, Math.floor((width - 16) / 8.43)));
    if (!width || cols === screen.cols) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { columns.value = String(cols); const rows = screen.rows; screen.resize(cols, rows); if (alive && lease?.session.status === 'running') void run(() => request('/api/terminal/resize', { ...identity(), cols, rows })); }, 100);
  });
  node.append(el('h3', '', t('tools.terminal')), controls, status, screen.node, receiver); observer.observe(node);
  const dispose = () => { alive = false; clearTimeout(timer); clearTimeout(resizeTimer); observer.disconnect(); inputQueue = ''; if (lease?.session.status === 'running') void request('/api/terminal/stop', identity()).catch(() => undefined); };
  return { node, dispose };
}
