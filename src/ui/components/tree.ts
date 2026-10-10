import type { AppState, ProjectView, TaskView } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, confirmModal, disclosure, el, input, link, projectHash, renameModal, run, taskHash, type ViewContext } from './dom.ts';
import { filterTree } from './tree-filter.ts';

const collapsed = new Set<string>(); const seenAttention = new Set<string>();
let searchText = '';
let dragging = '';
export function needsReply(task: TaskView): boolean { return task.state !== '完成' && (task.state === '等待回覆' || !!task.question); }
export function taskTone(state: AppState, project: string, task: TaskView): string {
  if (state.running.some(r => r.project === project && r.task === task.id)) return 'running';
  if (needsReply(task)) return 'reply'; if (task.confirm) return 'confirm';
  if (task.state === '完成') return 'done'; if (task.state === '暫停') return 'paused';
  if (task.state === '進行中' || task.hasChat) return 'processed';
  return 'untouched';
}
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
  root.append(search, content);
  const unreadKeys = new Set(state.unread.map(item => `${item.project}/${item.task}`));
  const unread = (p: string, task: string) => unreadKeys.has(`${p}/${task}`);
  const attentionKeys = new Set<string>();
  for (const p of state.projects) {
    for (const task of p.tasks) {
      if (!needsReply(task) && !task.confirm && !unread(p.id, task.id) && !state.running.some(r => r.project === p.id && r.task === task.id)) continue;
      let currentTask: TaskView | undefined = task;
      const taskVisited = new Set<string>();
      while (currentTask && !taskVisited.has(currentTask.id)) {
        taskVisited.add(currentTask.id); attentionKeys.add(`${p.id}/${currentTask.id}`);
        currentTask = p.tasks.find(t => t.id === currentTask!.parent);
      }
      let currentProject: ProjectView | undefined = p;
      const projectVisited = new Set<string>();
      while (currentProject && !projectVisited.has(currentProject.id)) {
        projectVisited.add(currentProject.id); attentionKeys.add(`p/${currentProject.id}`);
        currentProject = state.projects.find(other => other.id === currentProject!.parent);
      }
    }
  }
  function menu(actions: { label: string; action: () => unknown }[]): HTMLElement {
    const details = disclosure('⋯', ...actions.map(a => button(a.label, () => { details.open = false; return a.action(); })));
    details.className = 'context-menu'; details.querySelector('summary')!.setAttribute('aria-label', t('common.actions')); return details;
  }
  function badges(p: ProjectView, tasks: TaskView[]): HTMLElement {
    const node = el('span', 'badges');
    const counts = [tasks.filter(task => unread(p.id, task.id)).length, tasks.filter(needsReply).length, tasks.filter(task => task.confirm && !needsReply(task)).length];
    (['tree.unread', 'tree.reply', 'tree.confirm'] as const).forEach((key, i) => { if (counts[i]) node.append(el('span', `badge badge-${i}`, `${t(key)}${counts[i]! > 1 ? ' ' + counts[i] : ''}`)); }); return node;
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
    control.disabled = !hasChildren; control.setAttribute('aria-label', t(collapsed.has(key) ? 'tree.expand' : 'tree.collapse')); return control;
  }
  function taskNode(p: ProjectView, task: TaskView, ancestry: Set<string>): HTMLElement {
    const wrap = el('div', 'tree-node task-node'); wrap.dataset['search'] = `${task.title} ${task.id}`.toLocaleLowerCase(); if (ancestry.has(task.id)) return wrap;
    const next = new Set(ancestry).add(task.id);
    const children = p.tasks.filter(t => t.parent === task.id);
    wrap.dataset['completed'] = String(task.state === '完成' && !unread(p.id, task.id));
    const key = `${p.id}/${task.id}`; const attention = attentionKeys.has(key);
    const line = el('div', 'tree-row');
    const title = link(`${task.parent ? '↳ ' : ''}${task.title}`, taskHash(p.id, task.id), 'tree-title');
    if (location.hash === title.hash) line.classList.add('selected');
    line.append(toggle(key, !!children.length, attention), el('span', `dot ${taskTone(state, p.id, task)}`), title, menu([
      { label: t('common.rename'), action: async () => { const title = await renameModal(task.title); if (title) { await request('/api/task/update', { project: p.id, task: task.id, patch: { title } }); await refresh(); } } },
      { label: t('tree.subtask'), action: () => { location.hash = `${projectHash(p.id)}?parent=${encodeURIComponent(task.id)}#add`; } },
      { label: t('tree.newBranch'), action: () => { location.hash = `${projectHash(p.id)}?derived=${encodeURIComponent(task.id)}#add`; } },
      { label: t('common.archive'), action: async () => { if (await confirmModal(t('common.archive'), t('common.confirmArchive', { name: task.title }), t('common.archive'))) { await request('/api/task/archive', { project: p.id, task: task.id }); await refresh(); } } },
    ]));
    wrap.append(line);
    if (task.kind === 'derived') wrap.append(el('div', 'branch-label', t('tree.branch', { source: p.tasks.find(t => t.id === task.derivedFrom)?.title ?? task.derivedFrom })));
    const notices = badges(p, [task]); if (notices.childNodes.length) wrap.append(notices);
    const nest = el('div', 'tree-children');
    nests.set(key, nest);
    for (const c of children) nest.append(taskNode(p, c, next));
    wrap.append(nest);
    return wrap;
  }
  function ordered(parent: string): ProjectView[] {
    const ids = state.order[parent] ?? [];
    return state.projects.filter(p => p.parent === parent).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (ids.indexOf(a.id) < 0 ? Infinity : ids.indexOf(a.id)) - (ids.indexOf(b.id) < 0 ? Infinity : ids.indexOf(b.id)));
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
    const tones = p.tasks.map(task => taskTone(state, p.id, task));
    const tone = p.status === '完成' ? 'done' : ['running', 'reply', 'confirm', 'processed', 'untouched', 'paused', 'done'].find(t => tones.includes(t)) ?? 'untouched';
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
    line.append(toggle(key, true, attention), el('span', `dot ${tone}`), title, menu([
      { label: t('common.rename'), action: async () => { const name = await renameModal(p.name); if (name) { await request('/api/project/update', { project: p.id, patch: { name } }); await refresh(); } } },
      { label: t(p.pinned ? 'tree.unpin' : 'tree.pin'), action: async () => { await request('/api/pin', { project: p.id, pinned: !p.pinned }); await refresh(); } },
      { label: t('tree.up'), action: () => move(p, -1) }, { label: t('tree.down'), action: () => move(p, 1) },
      { label: t('tree.subproject'), action: () => { location.hash = `#/new?parent=${encodeURIComponent(p.id)}`; } },
      { label: t('common.archive'), action: async () => { if (await confirmModal(t('common.archive'), t('common.confirmArchive', { name: p.name }), t('common.archive'))) { await request('/api/project/archive', { project: p.id }); await refresh(); } } },
    ]));
    wrap.append(line); const notices = badges(p, p.tasks); if (notices.childNodes.length) wrap.append(notices);
    const nest = el('div', 'tree-children');
    nests.set(key, nest);
    const tasks = p.tasks.filter(t => !t.parent || !p.tasks.some(other => other.id === t.parent));
    for (const task of tasks) nest.append(taskNode(p, task, new Set()));
    for (const child of ordered(p.id)) nest.append(projectNode(child, next));
    wrap.append(nest);
    return wrap;
  }
  const roots = ordered(''); for (const p of state.projects) if (p.parent && !state.projects.some(other => other.id === p.parent)) roots.push(p);
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
  filter();
  return root;
}
