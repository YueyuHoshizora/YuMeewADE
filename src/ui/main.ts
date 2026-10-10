import type { AppState, UsageState } from '../shared/types.ts';
import { api } from './api.ts';
import { getLocale, t } from './i18n/index.ts';
import { button, el, link, readLocal, run, showError, taskHash, toast, type View, type ViewContext } from './components/dom.ts';
import { aiLabel, localTime } from './components/display.ts';
import { quotaAlerts } from './components/quota-alert.ts';
import { needsReply, tree } from './components/tree.ts';
import { newProjectView, projectView } from './views/projects.ts';
import { taskView } from './views/task.ts';
import { turnView } from './views/turn.ts';
import { settingsView } from './views/settings.ts';
import { stream } from './components/stream.ts';
import { attention } from './components/attention.ts';
import { searchView } from './views/search.ts';
import { usageBar } from './components/usage.ts';
import { runningChip } from './components/running.ts';
import { openUsageDetails } from './components/usage-details.ts';

const header = document.getElementById('header')!; const sidebar = document.getElementById('sidebar')!; const main = document.getElementById('main')!; const footer = document.getElementById('footer')!;
let state: AppState | null = null; let usage: UsageState = { ais: [], tokensPerSecond: null }; let view: View | null = null; let route = ''; let viewTarget = ''; let refreshJob: Promise<void> | null = null; let refreshAgain = false; let debounce: number | undefined;
function notify(previous: AppState | null, next: AppState): void {
  const items = attention(next); window.yumeewade?.setBadge?.(items.length);
  if (!previous || !readLocal('yumeewade.notifications', true) || !('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) return;
  const before = attention(previous);
  for (const item of items) {
    if (before.some(old => old.project === item.project && old.task === item.task && old.kind === item.kind)) continue;
    const hash = taskHash(item.project, item.task); if (location.hash === hash && !document.hidden && document.hasFocus()) continue;
    try { const notice = new Notification(item.title, { body: t(item.kind === 'answer' ? 'notification.answer' : 'notification.done'), tag: hash }); notice.onclick = () => { window.yumeewade?.focus?.(); window.focus(); location.hash = hash; notice.close(); }; } catch { /* 系統不支援通知時不影響狀態更新。 */ }
  }
}

/** 額度剛用滿或剛恢復：一律彈出提示；視窗不在前景時另發系統通知（與完成通知共用開關）。 */
function announceQuota(next: UsageState): void {
  const alerts = quotaAlerts(usage, next);
  const messages: string[] = [];
  for (const alert of alerts) {
    const account = state?.settings.accounts[alert.ai]?.find(entry => entry.id === alert.account);
    const ai = `${aiLabel(alert.ai)} · ${account?.name ?? t('usage.defaultAccount')}`;
    const windows = alert.windows.join('/') || t('usage.limited');
    const message = alert.kind === 'recovered' ? t('usage.alertRecovered', { ai })
      : alert.resetsAt ? t('usage.alertFull', { ai, windows, reset: localTime(alert.resetsAt) })
        : t('usage.alertFullNoReset', { ai, windows });
    messages.push(message);
    if (!readLocal('yumeewade.notifications', true) || !('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) continue;
    try {
      const notice = new Notification(t('usage.alertTitle'), { body: message, tag: `quota-${alert.ai}-${alert.account}` });
      notice.onclick = () => { window.yumeewade?.focus?.(); window.focus(); if (state) openUsageDetails(() => state!, () => usage, refresh, alert.ai); notice.close(); };
    } catch { /* 系統通知不可用時，畫面內提示仍會顯示。 */ }
  }
  if (messages.length) toast(messages.join('\n'));
}

function drawShell(): void {
  if (!state) return;
  const tasks = state.projects.flatMap(p => p.tasks); const replies = tasks.filter(needsReply).length; const confirmations = tasks.filter(task => task.confirm && !needsReply(task)).length;
  const menu = button('☰', () => document.body.classList.toggle('sidebar-open'), 'menu-toggle'); menu.setAttribute('aria-label', t('nav.menu'));
  header.replaceChildren(menu, link(t('app.title'), '#/turn', 'brand'), el('span', 'version', `v${state.version}`), el('span', 'spacer'), link(`${t('nav.turn')} · ${t('tree.reply')} ${replies} · ${t('tree.confirm')} ${confirmations}`, '#/turn', 'turn-button'), link(t('nav.settings'), '#/settings', 'settings-button'));
  const searching = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('tree-search'); const top = sidebar.scrollTop;
  sidebar.replaceChildren(el('div', 'sidebar-heading', t('nav.projects')), tree({ state, refresh }), link(t('nav.new'), '#/new', 'new-project'));
  sidebar.scrollTop = top; if (searching) sidebar.querySelector<HTMLInputElement>('.tree-search')?.focus({ preventScroll: true });
  document.documentElement.lang = getLocale(); drawFooter();
}
function drawFooter(): void {
  if (!state) return;
  const chip = runningChip(state);
  footer.setAttribute('aria-label', t('usage.region')); footer.replaceChildren(...(chip ? [chip] : []), ...usageBar(state, usage, Date.now(), ai => openUsageDetails(() => state!, () => usage, refresh, ai)));
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
  else if (parts[0] === 'search') view = searchView();
  else if (parts[0] === 'p' && project) view = projectView(context, project, params);
  else if (parts[0] === 't' && project && task) view = taskView(context, project, task, params);
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
        refreshAgain = false; const next = await api.state(); notify(state, next); announceQuota(next.usage); state = next; usage = next.usage; drawShell();
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
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    location.hash = '#/search';
    return;
  }
  if (event.isComposing || event.keyCode === 229 || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]'))) return;
  if (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) { event.preventDefault(); document.body.classList.add('sidebar-open'); sidebar.querySelector<HTMLInputElement>('.tree-search')?.focus(); }
});
window.addEventListener('focus', () => { void refresh(); });
window.setInterval(() => { void refresh(); }, 15_000);
const events = stream('/api/events', {
  changed: () => { window.clearTimeout(debounce); debounce = window.setTimeout(() => { void refresh(); }, 150); },
  usage: event => { const next = JSON.parse(event.data) as UsageState; announceQuota(next); usage = next; drawFooter(); },
}, () => { void refresh(); });
window.addEventListener('pagehide', () => { events.close(); view?.dispose?.(); });
void refresh();
