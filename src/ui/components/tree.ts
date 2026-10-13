import type { AppState, ProjectView, TaskView } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { archiveFlow, button, confirmModal, disclosure, el, input, link, projectHash, renameModal, run, selectModal, taskHash, type ViewContext } from './dom.ts';
import { filterTree } from './tree-filter.ts';
import { metadataBadge } from './task-metadata.ts';

const collapsed = new Set<string>(); const seenAttention = new Set<string>();
let searchText = '';
let dragging = '';
export function needsReply(task: TaskView): boolean { return task.state !== '完成' && (task.state === '等待回覆' || !!task.question); }
/**
 * The two lists of 交給你嚕; the header counts come from the same split. A run waiting for a tool approval needs a reply
 * now, so it is never also offered for completion.
 */
export function turnItems(state: AppState): { reply: TurnItem[]; confirm: TurnItem[] } {
  const items = state.projects.flatMap(project => project.tasks.map(task => ({ project, task, waiting: state.running.some(r => r.project === project.id && r.task === task.id && !!r.approvals?.length) })));
  return { reply: items.filter(({ task, waiting }) => waiting || needsReply(task)), confirm: items.filter(({ task, waiting }) => task.confirm && !waiting && !needsReply(task)) };
}
export interface TurnItem { project: ProjectView; task: TaskView; waiting: boolean }
/** Tone from the task's own state; running is decided separately from the current running set. */
function taskTone(task: TaskView): string {
  if (needsReply(task)) return 'reply'; if (task.confirm) return 'confirm';
  if (task.state === '完成') return 'done'; if (task.state === '暫停') return 'paused';
  if (task.state === '進行中' || task.hasChat) return 'processed';
  return 'untouched';
}
// A pointer press outside an open ⋯ menu closes it, like any popup menu.
document.addEventListener('pointerdown', event => {
  for (const open of document.querySelectorAll<HTMLDetailsElement>('details.context-menu[open]')) if (!open.contains(event.target as Node)) open.open = false;
});
export function tree(context: ViewContext): HTMLElement {
  const { state, refresh } = context; const root = el('div', 'tree'); const content = el('div', 'tree-content');
  const search = input(searchText, t('tree.search')); search.type = 'search'; search.className = 'tree-search'; search.setAttribute('aria-label', t('tree.search'));
  const nodeIndex: { node: HTMLElement; parent: HTMLElement | null; text: string; completed: boolean }[] = [];
  const nests = new Map<string, HTMLElement>();
  function filter(): void {
    const term = searchText.trim().toLocaleLowerCase();
    filterTree(nodeIndex, term);
    for (const [key, nest] of nests) nest.hidden = !term && collapsed.has(key);
  }
  search.oninput = () => { searchText = search.value; filter(); };
  search.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); search.value = ''; search.dispatchEvent(new InputEvent('input')); } };
  root.append(search, link(t('search.title'), '#/search', 'search-link'), content);
  const unreadKeys = new Set(state.unread.map(item => `${item.project}/${item.task}`));
  const unread = (p: string, task: string) => unreadKeys.has(`${p}/${task}`);
  // Built once per render so large trees avoid repeated scans of every project/task (formerly quadratic).
  const runningKeys = new Set(state.running.map(r => `${r.project}/${r.task}`));
  const projectById = new Map(state.projects.map(p => [p.id, p]));
  const taskIndexes = new Map<string, { byId: Map<string, TaskView>; children: Map<string, TaskView[]> }>();
  const taskIndex = (p: ProjectView) => {
    let index = taskIndexes.get(p.id);
    if (!index) {
      index = { byId: new Map(p.tasks.map(task => [task.id, task])), children: new Map() };
      for (const task of p.tasks) if (task.parent) { const siblings = index.children.get(task.parent); if (siblings) siblings.push(task); else index.children.set(task.parent, [task]); }
      taskIndexes.set(p.id, index);
    }
    return index;
  };
  const tone = (p: string, task: TaskView) => runningKeys.has(`${p}/${task.id}`) ? 'running' : taskTone(task);
  const attentionKeys = new Set<string>();
  for (const p of state.projects) {
    for (const task of p.tasks) {
      if (!needsReply(task) && !task.confirm && !unread(p.id, task.id) && !runningKeys.has(`${p.id}/${task.id}`)) continue;
      let currentTask: TaskView | undefined = task;
      const taskVisited = new Set<string>();
      while (currentTask && !taskVisited.has(currentTask.id)) {
        taskVisited.add(currentTask.id); attentionKeys.add(`${p.id}/${currentTask.id}`);
        currentTask = currentTask.parent ? taskIndex(p).byId.get(currentTask.parent) : undefined;
      }
      let currentProject: ProjectView | undefined = p;
      const projectVisited = new Set<string>();
      while (currentProject && !projectVisited.has(currentProject.id)) {
        projectVisited.add(currentProject.id); attentionKeys.add(`p/${currentProject.id}`);
        currentProject = currentProject.parent ? projectById.get(currentProject.parent) : undefined;
      }
    }
  }
  function menu(actions: { label: string; action: () => unknown }[]): HTMLElement {
    const details = disclosure('⋯', ...actions.map(a => button(a.label, () => { details.open = false; return a.action(); })));
    details.className = 'context-menu'; const summary = details.querySelector('summary')!; summary.setAttribute('aria-label', t('common.actions'));
    // Menu keyboard model: arrows move between items (opening the menu), Esc closes and returns to the ⋯ button.
    details.addEventListener('keydown', event => {
      const items = [...details.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      if (event.key === 'Escape' && details.open) { event.preventDefault(); event.stopPropagation(); details.open = false; summary.focus(); return; }
      if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || !items.length) return;
      event.preventDefault(); details.open = true;
      const at = items.indexOf(document.activeElement as HTMLButtonElement); const step = event.key === 'ArrowDown' ? 1 : -1;
      items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length]!.focus();
    });
    // Only one menu open at a time.
    details.addEventListener('toggle', () => { if (details.open) for (const other of document.querySelectorAll<HTMLDetailsElement>('details.context-menu[open]')) if (other !== details) other.open = false; });
    return details;
  }
  function badges(p: ProjectView, tasks: TaskView[]): HTMLElement[] {
    const node = el('span', 'badges');
    const counts = [tasks.filter(task => unread(p.id, task.id)).length, tasks.filter(needsReply).length, tasks.filter(task => task.confirm && !needsReply(task)).length];
    (['tree.unread', 'tree.reply', 'tree.confirm'] as const).forEach((key, i) => { if (counts[i]) node.append(el('span', `badge badge-${i}`, `${t(key)}${counts[i]! > 1 ? ' ' + counts[i] : ''}`)); });
    return node.childNodes.length ? [node] : [];
  }
  function toggle(key: string, hasChildren: boolean, attention: boolean): HTMLButtonElement {
    if (attention && !seenAttention.has(key)) { collapsed.delete(key); seenAttention.add(key); }
    if (!attention) seenAttention.delete(key);
    const control = button(hasChildren ? collapsed.has(key) ? '▸' : '▾' : '·', () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      control.textContent = collapsed.has(key) ? '▸' : '▾';
      control.setAttribute('aria-label', t(collapsed.has(key) ? 'tree.expand' : 'tree.collapse'));
      control.setAttribute('aria-expanded', String(!collapsed.has(key)));
      filter();
    }, 'disclosure-button');
    control.disabled = !hasChildren;
    // A leaf's dot is decoration; announcing "Collapse" on it would be wrong.
    if (hasChildren) { control.setAttribute('aria-label', t(collapsed.has(key) ? 'tree.expand' : 'tree.collapse')); control.setAttribute('aria-expanded', String(!collapsed.has(key))); }
    else control.setAttribute('aria-hidden', 'true');
    return control;
  }
  function taskNode(p: ProjectView, task: TaskView, ancestry: Set<string>): HTMLElement {
    const wrap = el('div', 'tree-node task-node'); wrap.dataset['search'] = `${task.title} ${task.id}`.toLocaleLowerCase(); if (ancestry.has(task.id)) return wrap;
    const next = new Set(ancestry).add(task.id);
    const children = taskIndex(p).children.get(task.id) ?? [];
    wrap.dataset['completed'] = String(task.state === '完成' && !unread(p.id, task.id));
    const key = `${p.id}/${task.id}`; const attention = attentionKeys.has(key);
    const line = el('div', 'tree-row');
    const title = link(`${task.parent ? '↳ ' : ''}${task.title}`, taskHash(p.id, task.id), 'tree-title');
    title.append(metadataBadge(task));
    if (location.hash === title.hash) line.classList.add('selected');
    // Notices sit on the row itself: on their own line they doubled the height of every task with something unread.
    line.append(toggle(key, !!children.length, attention), el('span', `dot ${tone(p.id, task)}`), title, ...badges(p, [task]), menu([
      { label: t('common.rename'), action: async () => { const title = await renameModal(task.title); if (title) { await request('/api/task/update', { project: p.id, task: task.id, patch: { title } }); await refresh(); } } },
      { label: t('tree.subtask'), action: () => { location.hash = `${projectHash(p.id)}?parent=${encodeURIComponent(task.id)}#add`; } },
      { label: t('tree.newBranch'), action: () => { location.hash = `${projectHash(p.id)}?derived=${encodeURIComponent(task.id)}#add`; } },
      { label: t('common.archive'), action: async () => { if (await archiveFlow('/api/task/archive', { project: p.id, task: task.id }, task.title, 'archive_has_worktree')) await refresh(); } },
    ]));
    wrap.append(line);
    if (task.kind === 'derived') wrap.append(el('div', 'branch-label', t('tree.branch', { source: (task.derivedFrom ? taskIndex(p).byId.get(task.derivedFrom)?.title : undefined) ?? task.derivedFrom })));
    const nest = el('div', 'tree-children');
    nests.set(key, nest);
    for (const c of children) nest.append(taskNode(p, c, next));
    wrap.append(nest);
    return wrap;
  }
  function ordered(parent: string): ProjectView[] {
    // A project may be named `constructor`: an inherited Object member must not stand in for its child order.
    const position = new Map<string, number>(); (Object.hasOwn(state.order, parent) ? state.order[parent]! : []).forEach((id, index) => { if (!position.has(id)) position.set(id, index); });
    const at = (id: string) => position.get(id) ?? Infinity;
    return state.projects.filter(p => p.parent === parent).sort((a, b) => Number(b.pinned) - Number(a.pinned) || at(a.id) - at(b.id));
  }
  async function move(p: ProjectView, direction: number): Promise<void> {
    const siblings = ordered(p.parent); const at = siblings.findIndex(s => s.id === p.id); const other = at + direction;
    if (!siblings[other] || siblings[other]!.pinned !== p.pinned) return;
    [siblings[at], siblings[other]] = [siblings[other]!, siblings[at]!];
    await request('/api/order', { parent: p.parent, order: siblings.map(s => s.id) }); await refresh();
  }
  function projectNode(p: ProjectView, ancestry: Set<string>): HTMLElement {
    const wrap = el('div', 'tree-node project-node'); wrap.dataset['search'] = `${p.name} ${p.id}`.toLocaleLowerCase(); if (ancestry.has(p.id)) return wrap;
    const next = new Set(ancestry).add(p.id); const key = `p/${p.id}`;
    const attention = attentionKeys.has(key);
    const tones = new Set(p.tasks.map(task => tone(p.id, task)));
    const projectTone = p.status === '完成' ? 'done' : ['running', 'reply', 'confirm', 'processed', 'untouched', 'paused', 'done'].find(t => tones.has(t)) ?? 'untouched';
    const line = el('div', 'tree-row'); const title = link(`${p.pinned ? '◆ ' : ''}${p.parent ? '↳ ' : ''}${p.name}`, projectHash(p.id), 'tree-title');
    line.draggable = true;
    line.ondragstart = event => { dragging = p.id; event.dataTransfer?.setData('text/plain', p.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; };
    function clearDrop(): void { line.classList.remove('drop-before', 'drop-after'); }
    function validDrag(): ProjectView | undefined { return state.projects.find(other => other.id === dragging && other.id !== p.id && other.parent === p.parent && other.pinned === p.pinned); }
    line.ondragover = event => { if (!validDrag()) return; event.preventDefault(); clearDrop(); line.classList.add(event.clientY < line.getBoundingClientRect().top + line.offsetHeight / 2 ? 'drop-before' : 'drop-after'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; };
    line.ondragleave = clearDrop;
    line.ondragend = () => { dragging = ''; document.querySelectorAll('.drop-before,.drop-after').forEach(node => node.classList.remove('drop-before', 'drop-after')); };
    line.ondrop = event => {
      const source = validDrag(); const after = line.classList.contains('drop-after'); clearDrop(); if (!source) return; event.preventDefault(); dragging = '';
      const siblings = ordered(p.parent).filter(other => other.id !== source.id); const at = siblings.findIndex(other => other.id === p.id); siblings.splice(at + Number(after), 0, source);
      void run(async () => { await request('/api/order', { parent: p.parent, order: siblings.map(other => other.id) }); await refresh(); });
    };
    if (location.hash === title.hash) line.classList.add('selected');
    const missing: HTMLElement[] = [];
    if (p.bodyMissing) {
      const mark = el('span', 'tree-warning', '⚠'); const label = t('project.bodyMissing', { path: p.bodyPath });
      mark.title = label; mark.setAttribute('role', 'img'); mark.setAttribute('aria-label', label); missing.push(mark);
    }
    line.append(toggle(key, true, attention), el('span', `dot ${projectTone}`), title, ...missing, ...badges(p, p.tasks), menu([
      { label: t('common.rename'), action: async () => { const name = await renameModal(p.name); if (name) { await request('/api/project/update', { project: p.id, patch: { name } }); await refresh(); } } },
      { label: t(p.pinned ? 'tree.unpin' : 'tree.pin'), action: async () => { await request('/api/pin', { project: p.id, pinned: !p.pinned }); await refresh(); } },
      { label: t('tree.up'), action: () => move(p, -1) }, { label: t('tree.down'), action: () => move(p, 1) },
      { label: t('tree.subproject'), action: () => { location.hash = `#/new?parent=${encodeURIComponent(p.id)}`; } },
      { label: t('tree.moveParent'), action: async () => {
        // A project cannot move under itself or one of its descendants; offer only parents that keep the tree acyclic.
        const blocked = new Set([p.id]);
        for (let grew = true; grew;) { grew = false; for (const other of state.projects) if (!blocked.has(other.id) && blocked.has(other.parent)) { blocked.add(other.id); grew = true; } }
        const options = [{ value: '', label: t('common.none') }, ...state.projects.filter(other => !blocked.has(other.id)).map(other => ({ value: other.id, label: other.name }))];
        const parent = await selectModal(t('tree.moveParent'), t('project.parent'), options, p.parent);
        if (parent === null || parent === p.parent) return;
        await request('/api/project/update', { project: p.id, patch: { parent } }); await refresh();
      } },
      { label: t('common.archive'), action: async () => { if (await archiveFlow('/api/project/archive', { project: p.id }, p.name, 'archive_project_has_worktrees')) await refresh(); } },
    ]));
    wrap.append(line);
    const nest = el('div', 'tree-children');
    nests.set(key, nest);
    const tasks = p.tasks.filter(t => !t.parent || !taskIndex(p).byId.has(t.parent));
    for (const task of tasks) nest.append(taskNode(p, task, new Set()));
    for (const child of ordered(p.id)) nest.append(projectNode(child, next));
    wrap.append(nest);
    return wrap;
  }
  const roots = ordered(''); for (const p of state.projects) if (p.parent && !projectById.has(p.parent)) roots.push(p);
  for (const p of roots) content.append(projectNode(p, new Set()));
  for (const node of content.querySelectorAll<HTMLElement>('.tree-node')) {
    nodeIndex.push({
      node,
      parent: node.parentElement?.closest<HTMLElement>('.tree-node') ?? null,
      text: node.dataset['search'] ?? '',
      completed: node.dataset['completed'] === 'true',
    });
  }
  if (!roots.length) content.append(el('p', 'empty', t('common.empty')));
  if (state.unreadable.length) {
    const notice = el('aside', 'warning tree-unreadable', t('tree.unreadable', { n: state.unreadable.length }));
    const files = el('ul'); for (const file of state.unreadable) { const item = el('li'); item.append(el('code', '', file)); files.append(item); }
    notice.append(files); content.append(notice);
  }
  filter();
  return root;
}
