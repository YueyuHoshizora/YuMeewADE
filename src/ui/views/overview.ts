import { TASK_STATES } from '../../shared/types.ts';
import { labelValue, t } from '../i18n/index.ts';
import { el, field, link, projectHash, row, select, taskHash, type View, type ViewContext } from '../components/dom.ts';
import { metadataBadge } from '../components/task-metadata.ts';
import { aggregateOverview, type OverviewTask } from './overview-logic.ts';

export function overviewView(context: ViewContext): View {
  const node = el('div', 'page overview-page'); const filter = el('div'); const content = el('div', 'overview-grid'); let tag = '';
  const lists = (items: OverviewTask[]) => {
    const list = el('ul', 'overview-list');
    for (const { project, task } of items) {
      const item = el('li'); item.append(link(task.title, taskHash(project.id, task.id)), row(link(project.name, projectHash(project.id)), el('span', 'state-chip', t(`state.${task.state}`)), metadataBadge(task))); list.append(item);
    }
    if (!items.length) list.append(el('li', 'muted', t('common.empty')));
    return list;
  };
  function render(): void {
    const data = aggregateOverview(context.state, tag);
    const tags = select([{ value: '', label: t('overview.allTags') }, ...data.tags.map(value => ({ value, label: value }))], tag);
    tags.onchange = () => { tag = tags.value; render(); filter.querySelector('select')?.focus(); };
    filter.replaceChildren(field(t('overview.tagFilter'), tags));
    const totals = el('section', 'overview-card overview-wide'); totals.append(el('h2', '', t('overview.states')));
    const counts = el('div', 'overview-counts');
    for (const state of TASK_STATES) {
      const details = el('details'); details.append(el('summary', '', `${t(`state.${state}`)} · ${data.totals[state]}`), lists(data.tasks.filter(item => item.task.state === state))); counts.append(details);
    }
    totals.append(counts); content.replaceChildren(totals);
    for (const [title, items] of [
      [t('overview.overdue'), data.overdue], [t('overview.upcoming'), data.upcoming],
      [t('overview.waiting'), data.waiting], [t('overview.running'), data.running], [t('overview.unread'), data.unread],
    ] as const) {
      const section = el('section', 'overview-card'); section.append(el('h2', '', `${title} · ${items.length}`), lists(items)); content.append(section);
    }
    const projects = el('section', 'overview-card overview-wide'); projects.append(el('h2', '', t('overview.projects')));
    for (const { project, done, total } of data.projects) {
      const progress = el('progress'); progress.max = total || 1; progress.value = done;
      progress.setAttribute('aria-label', `${project.name}: ${done}/${total}`);
      projects.append(row(link(project.name, projectHash(project.id)), el('span', '', `${done}/${total}`), progress, el('span', 'muted', labelValue(t('overview.phase'), project.currentPhase || t('common.none')))));
    }
    if (!data.projects.length) projects.append(el('p', 'muted', t('common.empty')));
    content.append(projects);
  }
  node.append(el('h1', '', t('overview.title')), el('p', 'muted', t('overview.hint')), filter, content); render();
  return { node, update: state => { context.state = state; render(); } };
}
