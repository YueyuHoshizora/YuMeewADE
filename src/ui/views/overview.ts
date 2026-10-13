import { TASK_STATES } from '../../shared/types.ts';
import { getLocale, t } from '../i18n/index.ts';
import { el, field, link, projectHash, row, select, taskHash, type View, type ViewContext } from '../components/dom.ts';
import { metadataBadge } from '../components/task-metadata.ts';
import { aggregateOverview, type OverviewTask } from './overview-logic.ts';

export function overviewView(context: ViewContext): View {
  const node = el('div', 'page overview-page'); const filter = el('div'); const content = el('div', 'overview-grid'); let tag = '';
  // Every state refresh rebuilds the page; which state groups the reader opened is kept by state key.
  const opened = new Set<string>();
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
    tags.onchange = () => { tag = tags.value; render(); };
    const refocus = filter.contains(document.activeElement);
    // A tag filter with no tags offers only "all tags"; show it once there is something to filter by.
    filter.replaceChildren(...(data.tags.length ? [field(t('overview.tagFilter'), tags)] : []));
    if (refocus) tags.focus();
    // What needs a person comes first; groups with nothing in them shrink to one line instead of a card each.
    const quiet: string[] = [];
    content.replaceChildren();
    for (const [title, items] of [
      [t('overview.waiting'), data.waiting], [t('overview.running'), data.running], [t('overview.overdue'), data.overdue],
      [t('overview.upcoming'), data.upcoming], [t('overview.unread'), data.unread],
    ] as const) {
      if (!items.length) { quiet.push(title); continue; }
      const section = el('section', 'overview-card'); section.append(el('h2', '', `${title} · ${items.length}`), lists(items)); content.append(section);
    }
    if (quiet.length) content.append(el('p', 'muted overview-quiet overview-wide', t('overview.nothing', { list: new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(quiet) })));
    const totals = el('section', 'overview-card overview-wide'); totals.append(el('h2', '', t('overview.states')));
    const counts = el('div', 'overview-counts');
    for (const state of TASK_STATES) {
      const details = el('details'); details.append(el('summary', '', `${t(`state.${state}`)} · ${data.totals[state]}`), lists(data.tasks.filter(item => item.task.state === state))); counts.append(details);
      details.open = opened.has(state);
      details.ontoggle = () => { if (details.open) opened.add(state); else opened.delete(state); };
    }
    totals.append(counts); content.append(totals);
    const projects = el('section', 'overview-card overview-wide'); projects.append(el('h2', '', t('overview.projects')));
    for (const { project, done, total } of data.projects) {
      const progress = el('progress'); progress.max = total || 1; progress.value = done;
      progress.setAttribute('aria-label', `${project.name}: ${done}/${total}`);
      projects.append(row(link(project.name, projectHash(project.id)), el('span', '', `${done}/${total}`), progress));
    }
    if (!data.projects.length) projects.append(el('p', 'muted', t('common.empty')));
    content.append(projects);
  }
  node.append(el('h1', '', t('overview.title')), el('p', 'muted', t('overview.hint')), filter, content); render();
  return { node, update: state => { context.state = state; render(); } };
}
