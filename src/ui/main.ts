import type { AppState, UsageState } from '../shared/types.ts';
import { api } from './api.ts';
import { getLocale, t } from './i18n/index.ts';
import { button, el, link, readLocal, run, searchHash, showError, taskHash, toast, type View, type ViewContext } from './components/dom.ts';
import { aiLabel, localDateTime, localTime, quotaLabel } from './components/display.ts';
import { quotaAlerts, quotaCountdowns, type QuotaAlert } from './components/quota-alert.ts';
import { needsReply, tree } from './components/tree.ts';
import { newProjectView, openProjectFromFolder, openProjectView, projectView } from './views/projects.ts';
import { stream } from './components/stream.ts';
import { attention } from './components/attention.ts';
import { usageBar } from './components/usage.ts';
import { runningChip } from './components/running.ts';
import { openUpdateDialog, updateChip, visibleUpdate } from './components/update.ts';
import { openUsageDetails } from './components/usage-details.ts';
import { showInitialCare } from './components/care.ts';
import { mountTerminalDock, setTerminalScope, toggleTerminalDock } from './components/terminal-dock.ts';
import { openCommandPalette, paletteShortcut } from './components/palette.ts';
import { openFindBar } from './components/find-bar.ts';
import { terminalFilePath } from './components/terminal-links.ts';
import { mountEditorWorkbench, setWorkbenchScope } from './components/editor-loader.ts';

const header = document.getElementById('header')!; const sidebar = document.getElementById('sidebar')!; const main = document.getElementById('main')!; const footer = document.getElementById('footer')!;
// Keyboard users would otherwise tab through the whole header and project tree before reaching the page.
main.tabIndex = -1;
document.body.prepend(button(t('nav.skip'), () => main.focus(), 'skip-link'));
mountTerminalDock();
mountEditorWorkbench(main);
let state: AppState | null = null; let usage: UsageState = { ais: [], tokensPerSecond: null }; let view: View | null = null; let route = ''; let viewTarget = ''; let refreshJob: Promise<void> | null = null; let refreshAgain = false; let debounce: number | undefined;
/** Serialized last drawn snapshot; background polls skip rebuilding the sidebar and view when it is unchanged. */
let stateText = ''; let pendingDraw = false;
// Route modules are intentionally deferred until their view is actually visited.
function lazyView(load: () => Promise<View>): View {
  const node = el('div', 'page', t('common.loading')); let disposed = false; let mounted: View | undefined; let latest: AppState | undefined;
  // Once mounted the wrapper must not add a box: route views bring their own padding and the task page needs #main's full height.
  void run(async () => { const next = await load(); if (disposed) { next.dispose?.(); return; } mounted = next; node.className = 'lazy-view'; node.replaceChildren(next.node); if (latest) next.update?.(latest); });
  return { node, update: next => { latest = next; mounted?.update?.(next); }, dispose: () => { disposed = true; mounted?.dispose?.(); } };
}
let initialCareShown = false;
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

/** 額度提醒只使用標準系統通知，前景與背景皆通知；沿用通知開關與授權。 */
const firedCountdowns = new Set<string>();
function deliverQuota(alerts: QuotaAlert[]): void {
  for (const alert of alerts) {
    const account = state?.settings.accounts[alert.ai]?.find(entry => entry.id === alert.account);
    const ai = `${aiLabel(alert.ai)} · ${account?.name ?? t('usage.defaultAccount')}`;
    const windows = alert.windows.map(quotaLabel).join('/') || t('usage.limited');
    const reset = alert.resetsAt ? localTime(alert.resetsAt) : '';
    const message = alert.kind === 'recovered' ? t('usage.alertRecovered', { ai })
      : alert.kind === 'low' ? t('usage.alertLow', { ai, windows, threshold: alert.threshold ?? 20, remaining: alert.remaining ?? 0 })
        : alert.kind === 'soon' ? t('usage.alertSoon', { ai, minutes: alert.minutes ?? 1, reset })
          : alert.resetsAt ? t('usage.alertFull', { ai, windows, reset })
            : t('usage.alertFullNoReset', { ai, windows });
    if (!readLocal('yumeewade.notifications', true) || !('Notification' in window) || Notification.permission !== 'granted') continue;
    try {
      const notice = new Notification(t('usage.alertTitle'), { body: message, tag: `quota-${alert.ai}-${alert.account}-${alert.kind}${alert.threshold ?? alert.minutes ?? ''}` });
      notice.onclick = () => { window.yumeewade?.focus?.(); window.focus(); if (state) openUsageDetails(() => state!, () => usage, refresh, alert.ai); notice.close(); };
    } catch { /* 系統通知不可用時不影響額度更新。 */ }
  }
}
function announceQuota(next: UsageState): void { deliverQuota(quotaAlerts(usage, next)); announceCodexReset(next); }
let notifiedUpdate: string | undefined;
/** 發現（尚未略過的）新版本就通知一次；同一個版本不重複打擾。 */
function announceUpdate(next: AppState): void {
  const info = visibleUpdate(next.update);
  if (!info || info.version === notifiedUpdate) return;
  const first = notifiedUpdate === undefined; notifiedUpdate = info.version;
  if (first && !document.hidden && document.hasFocus()) return;
  if (!readLocal('yumeewade.notifications', true) || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notice = new Notification(t('update.title'), { body: t('update.notice', { version: info.version }), tag: `update-${info.version}` });
    notice.onclick = () => { window.yumeewade?.focus?.(); window.focus(); openUpdateDialog(info, next.version, drawShell); notice.close(); };
  } catch { /* 系統通知不可用時不影響狀態更新。 */ }
}
let notifiedReset: string | undefined;
/** 抓到（新的）Codex 重置排程就通知一次；同一個排程不重複打擾。 */
function announceCodexReset(next: UsageState): void {
  if (!next.codexReset || next.codexReset === notifiedReset) return;
  notifiedReset = next.codexReset;
  if (!readLocal('yumeewade.notifications', true) || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notice = new Notification(t('usage.alertTitle'), { body: t('usage.codexResetNotice', { at: localDateTime(next.codexReset) }), tag: `codex-reset-${next.codexReset}` });
    notice.onclick = () => { window.yumeewade?.focus?.(); window.focus(); notice.close(); };
  } catch { /* 系統通知不可用時不影響狀態更新。 */ }
}

function drawShell(): void {
  if (!state) return;
  const tasks = state.projects.flatMap(p => p.tasks); const replies = tasks.filter(needsReply).length; const confirmations = tasks.filter(task => task.confirm && !needsReply(task)).length;
  const menu = button('☰', () => document.body.classList.toggle('sidebar-open'), 'menu-toggle'); menu.setAttribute('aria-label', t('nav.menu'));
  header.replaceChildren(menu, link(t('app.title'), '#/turn', 'brand'), el('span', 'version', `v${state.version}`), ...(visibleUpdate(state.update) ? [updateChip(state.update!, state.version, drawShell)] : []), el('span', 'spacer'), link(`${t('nav.turn')} · ${t('tree.reply')} ${replies} · ${t('tree.confirm')} ${confirmations}`, '#/turn', 'turn-button'), link(t('nav.settings'), '#/settings', 'settings-button'));
  header.append(button(t('terminalDock.toggle'), toggleTerminalDock, 'terminal-toggle'));
  const searching = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('tree-search'); const top = sidebar.scrollTop;
  const shell = { state, refresh }; sidebar.replaceChildren(link(t('overview.title'), '#/overview', 'new-project'), el('div', 'sidebar-heading', t('nav.projects')), tree(shell), button(t('project.openExisting'), () => openProjectFromFolder(shell), 'new-project'), link(t('nav.new'), '#/new', 'new-project'));
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
  else if (parts[0] === 'open') view = openProjectView(context);
  else if (parts[0] === 'settings') view = lazyView(async () => (await import('./views/settings.ts')).settingsView(context, () => { drawShell(); navigate(true); }));
  else if (parts[0] === 'search') view = lazyView(async () => (await import('./views/search.ts')).searchView(context, params));
  else if (parts[0] === 'overview') view = lazyView(async () => (await import('./views/overview.ts')).overviewView(context));
  else if (parts[0] === 'p' && project) view = projectView(context, project, params);
  else if (parts[0] === 't' && project && task) view = lazyView(async () => (await import('./views/task.ts')).taskView(context, project, task, params));
  else view = lazyView(async () => (await import('./views/turn.ts')).turnView(context));
  main.classList.toggle('task-main', parts[0] === 't' && !waiting);
  main.replaceChildren(view.node); main.scrollTop = 0; document.body.classList.remove('sidebar-open'); drawShell();
  setWorkbenchScope(project?.id ?? '', task?.id ?? '', state.root); setTerminalScope(project?.id ?? '', task?.id ?? '');
}
/** Full redraw after any explicit change; exposed to views, so it must not accept arguments. */
function refresh(): Promise<void> { return load(false); }
/** `quiet` is for background polls: an identical snapshot only refreshes the time-based footer. */
function load(quiet: boolean): Promise<void> {
  if (!quiet) pendingDraw = true;
  // 建立後的呼叫必須等到真正取得新 state；正在抓取時不能提早 resolve。
  if (refreshJob) { refreshAgain = true; return refreshJob; }
  refreshJob = (async () => {
    try {
      do {
        refreshAgain = false; const draw = pendingDraw; pendingDraw = false;
        const next = await api.state(); const text = JSON.stringify(next); const workspaceChanged = state !== null && state.root !== next.root;
        if (workspaceChanged) window.dispatchEvent(new CustomEvent('yumeewade:workspace-changed', { detail: { root: next.root } }));
        notify(state, next); announceQuota(next.usage); announceUpdate(next);
        if (!draw && !workspaceChanged && text === stateText) { usage = next.usage; drawFooter(); continue; }
        stateText = text; state = next; usage = next.usage; drawShell();
        navigate(workspaceChanged); view?.update?.(state);
        if (!initialCareShown) { initialCareShown = true; showInitialCare({ state, refresh }); }
      } while (refreshAgain);
    } catch (error) {
      showError(error); if (!view) main.replaceChildren(button(t('common.loading'), refresh, 'retry'));
    } finally { refreshJob = null; }
  })();
  return refreshJob;
}
window.addEventListener('hashchange', () => { void run(async () => navigate()); });
window.addEventListener('yumeewade:menu', event => {
  const command = (event as CustomEvent<{ command: string }>).detail?.command;
  if (command === 'palette' && state) openCommandPalette({ state, refresh });
  else if (command === 'find') openFindBar();
});
// Terminal paths are printed relative to (or absolute within) the same root the task editor uses.
window.addEventListener('yumeewade:terminal-path', event => {
  const { project: projectId, task: taskId, path, line } = (event as CustomEvent<{ project: string; task: string; path: string; line?: number }>).detail;
  const project = state?.projects.find(p => p.id === projectId); const task = project?.tasks.find(item => item.id === taskId);
  if (!project) return;
  const root = task && task.workspace !== 'direct' && task.workdir && !task.copyMissing ? task.workdir : project.bodyPath;
  const relative = terminalFilePath(path, root);
  if (!relative) { toast(t('terminalLinks.outside')); return; }
  window.dispatchEvent(new CustomEvent('yumeewade:open-file', { detail: { project: projectId, task: taskId, path: relative, ...(line ? { line } : {}) } }));
});
window.addEventListener('keydown', event => {
  if (state && paletteShortcut(event, { state, refresh })) return;
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    location.hash = searchHash();
    return;
  }
  // Electron has no find bar; browsers keep their own. Editors and the terminal claim the key first via preventDefault.
  const desktop = window.yumeewade;
  if (desktop?.desktop && !event.defaultPrevented && !event.shiftKey && !event.altKey && (desktop.platform === 'darwin' ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openFindBar();
    return;
  }
  if (event.isComposing || event.keyCode === 229 || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]'))) return;
  if (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) { event.preventDefault(); document.body.classList.add('sidebar-open'); sidebar.querySelector<HTMLInputElement>('.tree-search')?.focus(); }
});
window.addEventListener('focus', () => { void load(true); });
// Hidden windows rely on the SSE stream for changes; the poll is only a fallback while visible.
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(true); });
window.setInterval(() => { if (!document.hidden) void load(true); }, 15_000);
window.setInterval(() => { deliverQuota(quotaCountdowns(usage, Date.now(), firedCountdowns)); }, 15_000);
const events = stream('/api/events', {
  changed: () => { window.clearTimeout(debounce); debounce = window.setTimeout(() => { void refresh(); }, 150); },
  usage: event => { const next = JSON.parse(event.data) as UsageState; announceQuota(next); usage = next; drawFooter(); },
  care_backup_failed: () => toast(t('care.scheduleFailed')),
  usage_record_failed: () => toast(t('usageHistory.recordFailed')),
}, () => { void refresh(); });
window.addEventListener('pagehide', () => { events.close(); view?.dispose?.(); });
void refresh();
window.yumeewade?.onMenuCommand?.(command => {
  window.dispatchEvent(new CustomEvent('yumeewade:menu', { detail: { command } }));
  if (command === 'new-project') location.hash = '#/new';
  else if (command === 'settings') location.hash = '#/settings';
  else if (command === 'search') location.hash = searchHash();
  else if (command === 'open-project') void run(async () => { if (!state) await refresh(); if (state) await openProjectFromFolder({ state, refresh }); });
});
