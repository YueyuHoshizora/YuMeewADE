import { query, request } from '../api.ts';
import { LOCALES, localeName, setLocale, t } from '../i18n/index.ts';
import { getTheme, setTheme } from '../theme.ts';
import { openProjectFromFolder } from '../views/projects.ts';
import { archiveButton } from './archive.ts';
import { button, confirmModal, el, input, projectHash, row, run, taskHash, type ViewContext } from './dom.ts';
import { executionButton } from './execution.ts';
import { openFileBrowser } from './files.ts';
import { gitWorkbenchButton } from './git-workbench.ts';
import { fileQuery, rank, routeScope } from './palette-logic.ts';

type Command = { label: string; action: () => unknown };
let active: HTMLDialogElement | undefined;
function picker(title: string, source: (query: string) => Promise<Command[]> | Command[], delay = 0): void {
  active?.close();
  const dialog = el('dialog', 'modal'); active = dialog;
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', title);
  const search = input('', title); search.setAttribute('aria-label', title); search.setAttribute('role', 'combobox'); search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-expanded', 'true');
  const list = el('div', 'stack'); list.id = 'palette-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', title); search.setAttribute('aria-controls', list.id);
  list.style.maxHeight = '55vh'; list.style.overflowY = 'auto';
  let results: Command[] = []; let selected = 0; let generation = 0;
  let debounce: number | undefined;
  const choose = (index: number) => { const entry = results[index]; if (!entry) return; dialog.close(); void run(async () => { await entry.action(); }); };
  function highlight(): void {
    for (const [index, child] of [...list.children].entries()) { child.setAttribute('aria-selected', String(index === selected)); (child as HTMLElement).style.fontWeight = index === selected ? 'bold' : ''; }
    const option = list.children[selected];
    if (option && results.length) { search.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); } else search.removeAttribute('aria-activedescendant');
  }
  async function update(): Promise<void> {
    const token = ++generation; const entries = await source(search.value);
    if (token !== generation || !dialog.isConnected) return;
    results = entries; selected = 0;
    list.replaceChildren(...results.map((entry, index) => { const node = button(entry.label, () => choose(index)); node.id = `palette-option-${index}`; node.setAttribute('role', 'option'); node.tabIndex = -1; return node; }));
    if (!results.length) list.append(el('p', 'muted', t('palette.empty')));
    highlight();
  }
  search.oninput = () => {
    generation++; results = []; list.replaceChildren(); search.removeAttribute('aria-activedescendant');
    window.clearTimeout(debounce);
    if (delay) debounce = window.setTimeout(() => { void run(update); }, delay); else void run(update);
  };
  dialog.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (results.length) selected = (selected + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length; highlight(); }
    if (event.key === 'Enter') { event.preventDefault(); choose(selected); }
  });
  dialog.append(row(el('h2', '', title), button(t('common.close'), () => dialog.close())), search, list);
  dialog.addEventListener('close', () => { generation++; window.clearTimeout(debounce); dialog.remove(); if (active === dialog) active = undefined; });
  document.body.append(dialog); dialog.showModal(); search.focus(); void run(update);
}
export function openCommandPalette(context: ViewContext): void {
  const go = (hash: string) => () => { location.hash = hash; };
  const commands: Command[] = [
    { label: t('nav.new'), action: go('#/new') },
    { label: t('project.openExisting'), action: () => openProjectFromFolder(context) },
    { label: t('nav.settings'), action: go('#/settings') },
    { label: t('search.title'), action: go('#/search') },
    { label: t('nav.turn'), action: go('#/turn') },
    { label: t('palette.theme'), action: () => setTheme(getTheme() === 'dark' ? 'light' : 'dark') },
    { label: t('archive.browse'), action: () => archiveButton(context).click() },
  ];
  for (const locale of LOCALES) commands.push({ label: `${t('palette.language')} · ${localeName(locale)}`, action: () => { setLocale(locale); location.reload(); } });
  for (const project of context.state.projects) {
    commands.push({ label: project.name, action: go(projectHash(project.id)) });
    for (const task of project.tasks) commands.push({ label: `${project.name} · ${task.title}`, action: go(taskHash(project.id, task.id)) });
  }
  const scope = routeScope(location.hash);
  const project = context.state.projects.find(project => project.id === scope?.project);
  if (scope && project && (!scope.task || project.tasks.some(task => task.id === scope.task))) {
    commands.push({ label: t('palette.files'), action: () => openFileBrowser(scope.project, scope.task) }, { label: t('workbench.title'), action: () => gitWorkbenchButton(context, scope.project, scope.task || undefined).click() });
    if (scope.task) commands.push({ label: t('execution.title'), action: () => executionButton(context, scope.project, scope.task).click() });
  }
  if (context.state.running.length) commands.push({ label: t('running.stopAll'), action: async () => {
    if (!await confirmModal(t('running.stopAll'), t('running.stopAllConfirm', { n: context.state.running.length }), t('chat.stop'))) return;
    await Promise.all(context.state.running.map(info => request('/api/chat/stop', { project: info.project, task: info.task }))); await context.refresh();
  } });
  picker(t('palette.title'), query => rank(commands, query));
}
export function openGoToFile(context: ViewContext): boolean {
  const scope = routeScope(location.hash);
  const project = context.state.projects.find(project => project.id === scope?.project);
  if (!scope || !project || (scope.task && !project.tasks.some(task => task.id === scope.task))) return false;
  picker(t('palette.gotoFile'), async value => {
    const parsed = fileQuery(value);
    const found = await request<{ files: string[]; total: number }>(query('/api/task/files', { project: scope.project, ...(scope.task ? { task: scope.task } : {}), q: parsed.path }));
    return [
      ...found.files.map(path => ({ label: path, action: () => window.dispatchEvent(new CustomEvent('yumeewade:open-file', { detail: { ...scope, path, ...(parsed.line ? { line: parsed.line } : {}) } })) })),
    ];
  }, 150);
  return true;
}
export function openShortcutHelp(): void {
  active?.close();
  const dialog = el('dialog', 'modal'); active = dialog;
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', t('palette.help'));
  const shortcuts = [
    ['⌘/Ctrl+Shift+P', t('palette.title')], ['⌘/Ctrl+P', t('palette.gotoFile')],
    ['? · ⌘/Ctrl+/', t('palette.help')], ['/ · ⌘/Ctrl+K', t('palette.sidebar')],
    ['⌘/Ctrl+Shift+F', t('search.title')], ['⌘/Ctrl+Enter · Enter · Shift+Enter', t('palette.send')],
    ['↑↓ · Enter · Tab · Esc', t('palette.menuKeys')], ['Esc', t('palette.treeEsc')],
    ['⌘/Ctrl+S', t('palette.save')], ['Ctrl · Enter · ↑↓←→', t('palette.terminal')],
  ];
  if (document.querySelector('.cm-editor')) shortcuts.push(['⌘/Ctrl+F · ⌘/Ctrl+Z · ⌘/Ctrl+Shift+Z · Ctrl+Y · Ctrl+Space · ⌘/Ctrl+Shift+L', t('palette.editorKeys')]);
  dialog.append(row(el('h2', '', t('palette.help')), button(t('common.close'), () => dialog.close())), ...shortcuts.map(([keys, description]) => row(el('kbd', '', keys), el('span', '', description))));
  dialog.addEventListener('close', () => { dialog.remove(); if (active === dialog) active = undefined; });
  document.body.append(dialog); dialog.showModal();
}
export function paletteShortcut(event: KeyboardEvent, context: ViewContext): boolean {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return false;
  const typing = event.target instanceof Element && Boolean(event.target.closest('input,textarea,select,[contenteditable]'));
  if (((event.ctrlKey || event.metaKey) && !event.altKey && event.key === '/') || (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === '?')) {
    event.preventDefault(); openShortcutHelp(); return true;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); openCommandPalette(context); return true; }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p' && openGoToFile(context)) { event.preventDefault(); return true; }
  return false;
}
