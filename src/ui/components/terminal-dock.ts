import { t } from '../i18n/index.ts';
import { button, el, readLocal, row, run, storeLocal } from './dom.ts';
import { embeddedTerminal, type TerminalTabs } from './terminal.ts';
import { discoverTerminalRecovery, resetTerminalRecovery } from './terminal-recovery.ts';

const groups = new Map<string, TerminalTabs>();
let panel: HTMLElement | undefined;
let chooser: HTMLSelectElement;
let content: HTMLElement;
let restoring: Promise<void> | undefined;
// Route the user is on; a terminal belongs to a task, so "new terminal" is offered only on task pages without terminals yet
// (an existing task group has its own "new terminal" button).
let scope: [project: string, task: string] = ['', ''];
let openHere: HTMLButtonElement | undefined;
let empty: HTMLElement | undefined;
function refreshControls(): void {
  if (openHere) openHere.hidden = !scope[1] || groups.has(JSON.stringify(scope));
  if (empty) empty.hidden = groups.size > 0;
}
export function setTerminalScope(project: string, task: string): void { scope = [project, task]; refreshControls(); }
let workspaceEpoch = 0;
let visible = readLocal<boolean>('yumeewade.terminalDock.visible', false) === true;
let height = readLocal('yumeewade.terminalDock.height', 320);
function setHeight(value: number): void {
  height = Math.max(160, Math.min(Math.floor(window.innerHeight * .7), Number.isFinite(value) ? value : 320));
  document.body.style.setProperty('--terminal-dock-height', `${height}px`);
}
function show(value: boolean): void {
  visible = value; mountTerminalDock(); panel!.hidden = !visible;
  document.body.classList.toggle('terminal-dock-open', visible);
  storeLocal('yumeewade.terminalDock.visible', visible);
}
function selectGroup(key: string): void {
  chooser.value = key;
  for (const [id, group] of groups) group.node.hidden = id !== key;
}
export function mountTerminalDock(): void {
  if (panel) return;
  panel = el('section', 'terminal-dock'); panel.setAttribute('aria-label', t('terminalDock.toggle'));
  chooser = el('select'); chooser.setAttribute('aria-label', t('tools.terminal'));
  chooser.addEventListener('change', () => selectGroup(chooser.value));
  content = el('div', 'terminal-dock-content');
  const handle = el('div', 'terminal-dock-resize'); handle.tabIndex = 0;
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'horizontal'); handle.setAttribute('aria-label', t('terminalDock.height'));
  let dragging = false;
  handle.addEventListener('pointerdown', event => { dragging = true; handle.setPointerCapture(event.pointerId); event.preventDefault(); });
  handle.addEventListener('pointermove', event => { if (dragging) { setHeight(window.innerHeight - event.clientY - (document.getElementById('footer')?.offsetHeight ?? 30)); storeLocal('yumeewade.terminalDock.height', height); } });
  const finish = () => { dragging = false; };
  handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  handle.addEventListener('keydown', event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setHeight(height + (event.key === 'ArrowUp' ? 20 : -20)); storeLocal('yumeewade.terminalDock.height', height); } });
  openHere = button(t('terminalTabs.new'), () => run(() => openDockTerminal(scope[0], scope[1])));
  empty = el('p', 'muted', t('terminalDock.empty'));
  panel.append(handle, row(el('strong', '', t('terminalDock.toggle')), chooser, openHere, button(t('common.close'), () => show(false))), empty, content);
  refreshControls();
  document.getElementById('footer')!.before(panel);
  setHeight(height); panel.hidden = !visible; document.body.classList.toggle('terminal-dock-open', visible);
  window.addEventListener('resize', () => setHeight(height));
  window.addEventListener('keydown', event => { if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.code === 'Backquote') { event.preventDefault(); event.stopPropagation(); show(!visible); } }, true);
  // Navigation and hiding never dispose leases. A lost renderer is reclaimed by the server idle timeout.
  window.addEventListener('yumeewade:terminal-unavailable', () => {
    const notice = el('p', 'muted', t('terminalRecovery.unavailable')); content.append(notice); show(true);
  });
  window.addEventListener('yumeewade:workspace-changed', resetTerminalDock);
  restoring = run(restoreDock).finally(() => { restoring = undefined; });
}
export function toggleTerminalDock(): void { show(!visible); }
function groupFor(project: string, task: string): TerminalTabs {
  const key = JSON.stringify([project, task]);
  let group = groups.get(key);
  if (!group) {
    group = embeddedTerminal(project, task); groups.set(key, group); content.append(group.node);
    const option = el('option', '', `${project} / ${task}`); option.value = key; chooser.append(option); refreshControls();
  }
  selectGroup(key); return group;
}
async function restoreDock(): Promise<void> {
  const epoch = workspaceEpoch;
  const tabs = await discoverTerminalRecovery();
  for (const tab of tabs) { if (epoch !== workspaceEpoch) return; await run(() => groupFor(tab.project, tab.task).restore(tab)); }
}
export function resetTerminalDock(): void {
  workspaceEpoch++;
  for (const group of groups.values()) group.dispose();
  groups.clear(); content?.replaceChildren(); chooser?.replaceChildren(); resetTerminalRecovery();
  restoring = undefined; refreshControls();
}
export async function openDockTerminal(project: string, task: string): Promise<void> {
  const epoch = workspaceEpoch;
  show(true); await restoring;
  if (epoch === workspaceEpoch) await groupFor(project, task).add();
}
export function dockTerminalButton(project: string, task: string): HTMLElement {
  return button(t('terminalDock.open'), () => run(() => openDockTerminal(project, task)));
}
