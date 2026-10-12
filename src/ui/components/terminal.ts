import type { TerminalLease, TerminalSession, TerminalRecoveryTab } from '../../shared/types.ts';
import { ApiFailure, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, confirmModal, el, field, input, renameModal, row, run } from './dom.ts';
import { TerminalScreen } from './terminal-screen.ts';
import { terminalKey, terminalPaste } from './terminal-input.ts';
import { bindTerminalRecovery, claimTerminalRecovery, forgetTerminalRecovery, initializeTerminalRecovery } from './terminal-recovery.ts';

interface TerminalPanel { node: HTMLElement; dispose: () => void; launch: () => Promise<void>; stop: () => Promise<void>; running: () => boolean; rename: (label: string) => Promise<void> }
function terminalSession(project: string, task: string, label: string, recover?: TerminalRecoveryTab): TerminalPanel {
  const node = el('section', 'card'); const screen = new TerminalScreen(100, 24, t('tools.terminal'));
  const status = el('p'); const controls = row();
  const columns = input('100'); const lines = input('24');
  for (const control of [columns, lines]) { control.type = 'number'; control.min = '2'; control.max = '300'; }
  const receiver = el('textarea'); receiver.setAttribute('aria-label', t('tools.terminalInput')); receiver.autocapitalize = 'off'; receiver.spellcheck = false;
  receiver.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;overflow:hidden';
  let lease: TerminalLease | undefined; let alive = true; let timer: number | undefined; let after = 0; let inputQueue = ''; let sending = false;
  let starting = false;
  let replaying = false;
  let recoveryReplay = Boolean(recover);
  const identity = () => ({ project, task, id: lease!.session.id, owner: lease!.owner });
  async function flush(): Promise<void> {
    if (sending || !lease || !alive) return;
    sending = true;
    try {
      while (inputQueue && alive) {
        let end = Math.min(16384, inputQueue.length);
        if (end < inputQueue.length && /[\uD800-\uDBFF]/u.test(inputQueue[end - 1]!)) end--;
        const text = inputQueue.slice(0, end); inputQueue = inputQueue.slice(end);
        await request('/api/terminal/input', { ...identity(), text });
      }
    }
    finally { sending = false; }
  }
  function send(text: string): void {
    if (replaying || !lease || lease.session.status !== 'running' || inputQueue.length + text.length > 65536) return;
    inputQueue += text; void run(flush);
  }
  screen.onReply = send;
  async function poll(): Promise<void> {
    if (!alive || !lease) return;
    try {
      const current = await request<TerminalSession>('/api/terminal/output', { ...identity(), after });
      if (!alive) return;
      if (current.output.length && current.output[0]!.sequence > after + 1) screen.write('\x1bc');
      replaying = recoveryReplay && after === 0;
      try { if (current.output.length) screen.write(current.output.map(event => event.text).join('')); }
      finally { replaying = false; recoveryReplay = false; }
      after = current.sequence; lease.session = current;
      status.textContent = `${t(current.status === 'running' ? 'tools.running' : 'tools.closed')}${current.truncated ? ' · ' + t('execution.truncated') : ''}`;
    } catch (error) {
      if (error instanceof ApiFailure && (error.status === 403 || error.status === 404)) {
        lease = undefined; inputQueue = ''; status.textContent = t('terminalRecovery.unavailable');
      }
      throw error;
    } finally { if (alive && lease?.session.status === 'running') timer = window.setTimeout(() => { void run(poll); }, 100); }
  }
  async function launch(): Promise<void> {
    if (!alive || starting || lease?.session.status === 'running') return;
    starting = true;
    try {
      if (!recover && lease) forgetTerminalRecovery(lease.session.id);
      await initializeTerminalRecovery();
      if (recover) {
        lease = await claimTerminalRecovery(recover); recover = undefined;
        screen.resize(lease.session.cols, lease.session.rows); columns.value = String(lease.session.cols); lines.value = String(lease.session.rows);
      } else {
        lease = await request<TerminalLease>('/api/terminal/start', { project, task, cols: screen.cols, rows: screen.rows });
        try { await bindTerminalRecovery(identity(), label); }
        catch (error) { await request('/api/terminal/stop', identity()); throw error; }
      }
      if (!alive) { await request('/api/terminal/stop', identity()); return; }
      // preventScroll: the root has overflow:hidden, so a focus-induced scroll of the page could never be undone by the user.
      after = 0; screen.write('\x1bc'); receiver.focus({ preventScroll: true }); await poll();
    } finally { starting = false; }
  }
  async function stop(): Promise<void> {
    if (lease?.session.status === 'running') {
      await request('/api/terminal/stop', identity()); lease.session.status = 'stopped'; clearTimeout(timer); status.textContent = t('tools.closed');
    }
    if (lease) forgetTerminalRecovery(lease.session.id);
  }
  controls.append(button(t('tools.terminal'), launch), button(t('execution.stop'), async () => {
    if (lease?.session.status === 'running' && await confirmModal(t('execution.stop'), t('terminalTabs.confirmClose'), t('execution.stop'))) await stop();
  }));
  controls.append(field(t('tools.columns'), columns), field(t('tools.rows'), lines), button(t('tools.resize'), async () => {
    const cols = Number(columns.value); const rows = Number(lines.value);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 300 || rows < 2 || rows > 300) return;
    if (lease?.session.status === 'running') await request('/api/terminal/resize', { ...identity(), cols, rows });
    screen.resize(cols, rows);
  }));
  receiver.addEventListener('keydown', event => {
    const value = terminalKey(event, screen.applicationCursor);
    if (value !== undefined) { event.preventDefault(); send(value); }
  });
  receiver.addEventListener('input', () => { if (receiver.value) { send(receiver.value); receiver.value = ''; } });
  receiver.addEventListener('paste', event => { const text = event.clipboardData?.getData('text/plain'); if (text) { event.preventDefault(); send(terminalPaste(text, screen.bracketedPaste)); } });
  // Handled on mousedown: focusing the hidden input on press can scroll the dock before the click lands.
  let linkPress = false;
  screen.node.addEventListener('mousedown', event => {
    linkPress = false;
    if (event.button !== 0 || (!event.metaKey && !event.ctrlKey)) return;
    const link = screen.linkAt(event.clientX, event.clientY); if (!link) return;
    event.preventDefault(); linkPress = true;
    if (link.kind === 'url') window.open(link.url, '_blank', 'noopener,noreferrer');
    else window.dispatchEvent(new CustomEvent('yumeewade:terminal-path', { detail: { project, task, path: link.path, ...(link.line ? { line: link.line } : {}) } }));
  });
  // Registered before the focus handler so the click that finishes a link press does not move focus into the shell.
  screen.node.addEventListener('click', event => { if (linkPress) { linkPress = false; event.stopImmediatePropagation(); } });
  screen.node.addEventListener('mousemove', event => { screen.node.style.cursor = (event.metaKey || event.ctrlKey) && screen.linkAt(event.clientX, event.clientY) ? 'pointer' : ''; });
  screen.node.addEventListener('focus', () => receiver.focus({ preventScroll: true })); screen.node.addEventListener('click', () => { if (!window.getSelection()?.toString()) receiver.focus({ preventScroll: true }); });
  let resizeTimer: number | undefined;
  const observer = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width ?? 0;
    const cols = Math.min(300, Math.max(20, Math.floor((width - 16) / 8.43)));
    if (!width || cols === screen.cols) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { columns.value = String(cols); const rows = screen.rows; screen.resize(cols, rows); if (alive && lease?.session.status === 'running') void run(() => request('/api/terminal/resize', { ...identity(), cols, rows })); }, 100);
  });
  node.append(el('h3', '', t('tools.terminal')), controls, status, screen.node, receiver); observer.observe(node);
  const dispose = () => { alive = false; clearTimeout(timer); clearTimeout(resizeTimer); observer.disconnect(); screen.dispose(); inputQueue = ''; if (lease) { forgetTerminalRecovery(lease.session.id); if (lease.session.status === 'running') void request('/api/terminal/stop', identity()).catch(() => undefined); } };
  return { node, dispose, launch, stop, running: () => lease?.session.status === 'running', rename: async value => { label = value; if (lease) await bindTerminalRecovery(identity(), label); } };
}

export interface TerminalTabs { node: HTMLElement; add: () => Promise<void>; restore: (tab: TerminalRecoveryTab) => Promise<void>; dispose: () => void }
/** Page-unique ids for tab ⇄ panel relationships; several task pages may each hold a terminal set. */
let tabIds = 0;
export function embeddedTerminal(project: string, task: string): TerminalTabs {
  const node = el('section', 'terminal-tabs');
  const tabs = row(); tabs.setAttribute('role', 'tablist');
  const body = el('div');
  const sessions: { label: string; terminal: TerminalPanel; tab: HTMLButtonElement }[] = [];
  let selected: typeof sessions[number] | undefined;
  let serial = 0;
  function select(entry: typeof sessions[number]): void {
    selected = entry;
    for (const item of sessions) {
      item.terminal.node.hidden = item !== entry;
      item.tab.setAttribute('aria-selected', String(item === entry));
      // Roving tabindex: Tab reaches only the selected tab, arrows move between tabs (WAI-ARIA tabs pattern).
      item.tab.tabIndex = item === entry ? 0 : -1;
    }
  }
  tabs.addEventListener('keydown', event => {
    const index = sessions.findIndex(item => item.tab === event.target);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const last = sessions.length - 1;
    const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(sessions[next]!); sessions[next]!.tab.focus();
  });
  async function create(recover?: TerminalRecoveryTab): Promise<void> {
    const label = recover?.label ?? `${t('tools.terminal')} ${++serial}`;
    const terminal = terminalSession(project, task, label, recover);
    const entry: typeof sessions[number] = { label, terminal, tab: button('', () => select(entry)) };
    entry.tab.setAttribute('role', 'tab'); entry.tab.textContent = entry.label;
    entry.tab.id = `terminal-tab-${++tabIds}`; terminal.node.id = `${entry.tab.id}-panel`;
    entry.tab.setAttribute('aria-controls', terminal.node.id);
    terminal.node.setAttribute('role', 'tabpanel'); terminal.node.setAttribute('aria-labelledby', entry.tab.id);
    sessions.push(entry); tabs.append(entry.tab); body.append(terminal.node); select(entry);
    try { await terminal.launch(); }
    catch (error) { sessions.splice(sessions.indexOf(entry), 1); terminal.dispose(); terminal.node.remove(); entry.tab.remove(); selected = undefined; if (sessions.length) select(sessions.at(-1)!); throw error; }
  }
  node.append(row(el('strong', '', `${project} / ${task}`),
    button(t('terminalTabs.new'), () => create()),
    button(t('terminalTabs.rename'), async () => {
      if (!selected) return;
      const label = (await renameModal(selected.label))?.trim();
      if (label && label.length <= 80) { await selected.terminal.rename(label); selected.label = label; selected.tab.textContent = label; }
    }),
    button(t('terminalTabs.close'), async () => {
      const entry = selected; if (!entry) return;
      if (entry.terminal.running() && !await confirmModal(t('terminalTabs.close'), t('terminalTabs.confirmClose'), t('execution.stop'))) return;
      await entry.terminal.stop(); entry.terminal.dispose(); entry.terminal.node.remove(); entry.tab.remove();
      sessions.splice(sessions.indexOf(entry), 1); selected = undefined;
      if (sessions.length) select(sessions.at(-1)!);
    })), tabs, body);
  return { node, add: () => create(), restore: tab => create(tab), dispose: () => { for (const entry of sessions) entry.terminal.dispose(); } };
}
