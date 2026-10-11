import { t } from '../i18n/index.ts';
import { button, el, readLocal, row, run, storeLocal } from './dom.ts';
import { embeddedTerminal, type TerminalTabs } from './terminal.ts';

const groups = new Map<string, TerminalTabs>();
let panel: HTMLElement | undefined;
let chooser: HTMLSelectElement;
let content: HTMLElement;
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
  panel.append(handle, row(el('strong', '', t('terminalDock.toggle')), chooser, button(t('common.close'), () => show(false))), content);
  document.getElementById('footer')!.before(panel);
  setHeight(height); panel.hidden = !visible; document.body.classList.toggle('terminal-dock-open', visible);
  window.addEventListener('resize', () => setHeight(height));
  window.addEventListener('keydown', event => { if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.code === 'Backquote') { event.preventDefault(); event.stopPropagation(); show(!visible); } }, true);
  // Navigation and hiding never dispose leases. A lost renderer is reclaimed by the server idle timeout.
}
export function toggleTerminalDock(): void { show(!visible); }
export async function openDockTerminal(project: string, task: string): Promise<void> {
  show(true);
  const key = JSON.stringify([project, task]);
  let group = groups.get(key);
  if (!group) {
    group = embeddedTerminal(project, task); groups.set(key, group); content.append(group.node);
    const option = el('option', '', `${project} / ${task}`); option.value = key; chooser.append(option);
  }
  selectGroup(key); await group.add();
}
export function dockTerminalButton(project: string, task: string): HTMLElement {
  return button(t('terminalDock.open'), () => run(() => openDockTerminal(project, task)));
}
