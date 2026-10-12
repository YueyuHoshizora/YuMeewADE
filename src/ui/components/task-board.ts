import { TASK_STATES, type ProjectView, type TaskState, type TaskView } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import { request } from '../api.ts';
import { disclosure, el, field, input, link, readLocal, row, run, select, storeLocal, taskHash, type ViewContext } from './dom.ts';
import { metadataBadge } from './task-metadata.ts';
import { selectTasks, taskSelection } from './task-board-model.ts';

export function taskBoard(context: ViewContext, project: ProjectView, list: (tasks: TaskView[]) => HTMLElement): HTMLElement {
  const key = `yumeewade.task-board.${project.id}`;
  const selection = taskSelection(readLocal<unknown>(key, null));
  const node = el('section', 'task-browser');
  const content = el('div');
  const view = select((['list', 'board'] as const).map(value => ({ value, label: t(`board.${value}`) })), selection.view);
  const sort = select((['updated', 'due', 'title', 'state'] as const).map(value => ({ value, label: t(`board.sort.${value}`) })), selection.sort);
  const tags = select([{ value: '', label: t('board.all') }, ...[...new Set([...project.tasks.flatMap(task => task.tags ?? []), ...(selection.tag ? [selection.tag] : [])])].sort().map(value => ({ value, label: value }))], selection.tag);
  const states = select([{ value: '', label: t('board.all') }, ...TASK_STATES.map(value => ({ value, label: t(`state.${value}`) }))], selection.state);
  const ais = select([{ value: '', label: t('board.all') }, ...[...new Set([...project.tasks.map(task => task.cli).filter(Boolean), ...(selection.ai ? [selection.ai] : [])])].sort().map(value => ({ value, label: value }))], selection.ai);
  const late = input(); late.type = 'checkbox'; late.checked = selection.overdue;
  const text = input(selection.text); text.type = 'search'; text.maxLength = 200; text.setAttribute('aria-label', t('board.search'));
  let moving = false;
  async function move(task: TaskView, state: TaskState): Promise<void> {
    if (moving || (task.state === state && !task.confirm)) return;
    moving = true;
    try {
      // The same endpoint as the task footer approves completion and revokes it on reopen.
      await request('/api/task/update', { project: project.id, task: task.id, patch: { state } });
      await context.refresh();
    } finally { moving = false; }
  }
  function render(): void {
    const tasks = selectTasks(project.tasks, selection);
    if (selection.view === 'list') { content.replaceChildren(list(tasks)); return; }
    const board = el('div', 'task-board');
    for (const state of TASK_STATES) {
      const column = el('section', 'task-board-column');
      const matches = tasks.filter(task => task.state === state);
      column.append(el('h3', '', `${t(`state.${state}`)} · ${matches.length}`));
      column.ondragover = event => { if (event.dataTransfer?.types.includes('application/x-yumeewade-task')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } };
      column.ondrop = event => {
        event.preventDefault();
        const task = tasks.find(task => task.id === event.dataTransfer?.getData('application/x-yumeewade-task'));
        if (task) void run(() => move(task, state));
      };
      for (const task of matches) {
        const card = el('article', 'task-board-card'); card.draggable = true;
        card.ondragstart = event => { if (event.dataTransfer) { event.dataTransfer.setData('application/x-yumeewade-task', task.id); event.dataTransfer.effectAllowed = 'move'; } };
        const heading = row(link(task.title, taskHash(project.id, task.id)));
        for (const [active, kind, label] of [
          [context.state.running.some(item => item.project === project.id && item.task === task.id), 'running', 'board.running'],
          [context.state.unread.some(item => item.project === project.id && item.task === task.id), 'unread', 'board.unread'],
        ] as const) if (active) { const dot = el('span', `dot ${kind}`); dot.title = t(label); dot.setAttribute('aria-label', t(label)); dot.setAttribute('role', 'img'); heading.append(dot); }
        const target = select(TASK_STATES.map(value => ({ value, label: t(`state.${value}`) })), task.state);
        target.setAttribute('aria-label', t('board.move'));
        target.onchange = () => { const state = target.value as TaskState; target.value = task.state; void run(() => move(task, state)); };
        card.append(heading, el('p', 'muted', task.cli || t('common.none')), metadataBadge(task), disclosure(t('board.move'), target));
        if (task.confirm) card.append(el('span', 'warning', t('board.approval')));
        column.append(card);
      }
      if (!matches.length) column.append(el('p', 'muted', t('common.empty')));
      board.append(column);
    }
    content.replaceChildren(board);
  }
  const controls = row(field(t('board.view'), view), field(t('board.sort'), sort), field(t('overview.tagFilter'), tags), field(t('board.state'), states), field(t('board.ai'), ais), field(t('tasks.overdue'), late), field(t('board.search'), text));
  const change = () => {
    Object.assign(selection, taskSelection({ view: view.value, sort: sort.value, tag: tags.value, state: states.value, ai: ais.value, overdue: late.checked, text: text.value }));
    storeLocal(key, selection); render();
  };
  for (const control of [view, sort, tags, states, ais, late]) control.onchange = change;
  text.oninput = change;
  node.append(controls, content); render();
  return node;
}
