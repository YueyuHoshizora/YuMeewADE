import type { AppState } from '../shared/types.ts';
import { api } from './api.ts';
import { getLocale, t } from './i18n/index.ts';
import { button, el, link, run, showError, type View, type ViewContext } from './components/dom.ts';
import { needsReply, tree } from './components/tree.ts';
import { newProjectView, projectView } from './views/projects.ts';
import { taskView } from './views/task.ts';
import { turnView } from './views/turn.ts';
import { settingsView } from './views/settings.ts';

const header = document.getElementById('header')!; const sidebar = document.getElementById('sidebar')!; const main = document.getElementById('main')!;
let state: AppState | null = null; let view: View | null = null; let route = ''; let viewTarget = ''; let refreshJob: Promise<void> | null = null; let refreshAgain = false; let debounce: number | undefined;

function drawShell(): void {
  if (!state) return;
  const tasks = state.projects.flatMap(p => p.tasks); const replies = tasks.filter(needsReply).length; const confirmations = tasks.filter(task => task.confirm && !needsReply(task)).length;
  const menu = button('☰', () => document.body.classList.toggle('sidebar-open'), 'menu-toggle'); menu.setAttribute('aria-label', t('nav.menu'));
  header.replaceChildren(menu, link(t('app.title'), '#/turn', 'brand'), el('span', 'version', `v${state.version}`), el('span', 'spacer'), link(`${t('nav.turn')} · ${t('tree.reply')} ${replies} · ${t('tree.confirm')} ${confirmations}`, '#/turn', 'turn-button'), link(t('nav.settings'), '#/settings', 'settings-button'));
  sidebar.replaceChildren(el('div', 'sidebar-heading', t('nav.projects')), tree({ state, refresh }), link(t('nav.new'), '#/new', 'new-project'));
  document.documentElement.lang = getLocale();
}
function navigate(force = false): void {
  if (!state) return;
  const hash = location.hash || '#/turn';
  const [path = '', search = ''] = hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent); const params = new URLSearchParams(search.split('#')[0]);
  const project = state.projects.find(p => p.id === parts[1]);
  const task = project?.tasks.find(t => t.id === parts[2]);
  const waiting = (parts[0] === 'p' && !project) || (parts[0] === 't' && (!project || !task));
  const target = `${hash}/${waiting ? 'waiting' : 'ready'}`;
  if (!force && route === hash && viewTarget === target) return;
  view?.dispose?.(); route = hash; viewTarget = target;
  const context: ViewContext = { state, refresh };
  if (waiting) view = { node: el('div', 'page empty', t('common.loading')) };
  else if (parts[0] === 'new') view = newProjectView(context, params);
  else if (parts[0] === 'settings') view = settingsView(context, () => { drawShell(); navigate(true); });
  else if (parts[0] === 'p' && project) view = projectView(context, project, params);
  else if (parts[0] === 't' && project && task) view = taskView(context, project, task);
  else view = turnView(context);
  main.classList.toggle('task-main', parts[0] === 't' && !waiting);
  main.replaceChildren(view.node); main.scrollTop = 0; document.body.classList.remove('sidebar-open'); drawShell();
}
function refresh(): Promise<void> {
  // 建立後的呼叫必須等到真正取得新 state；正在抓取時不能提早 resolve。
  if (refreshJob) { refreshAgain = true; return refreshJob; }
  refreshJob = (async () => {
    try {
      do {
        refreshAgain = false; state = await api.state(); drawShell();
        navigate(); view?.update?.(state);
      } while (refreshAgain);
    } catch (error) {
      showError(error); if (!view) main.replaceChildren(button(t('common.loading'), refresh, 'retry'));
    } finally { refreshJob = null; }
  })();
  return refreshJob;
}
window.addEventListener('hashchange', () => { void run(async () => navigate()); });
window.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]'))) return;
  if (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) { event.preventDefault(); document.body.classList.add('sidebar-open'); sidebar.querySelector<HTMLInputElement>('.tree-search')?.focus(); }
});
window.addEventListener('focus', () => { void refresh(); });
window.setInterval(() => { void refresh(); }, 15_000);
const events = new EventSource('/api/events');
events.addEventListener('changed', () => { window.clearTimeout(debounce); debounce = window.setTimeout(() => { void refresh(); }, 150); });
window.addEventListener('pagehide', () => { events.close(); view?.dispose?.(); });
void refresh();
