import type { Task } from '../../shared/types.ts';
import { overdue } from '../../shared/task-metadata.ts';
import { t } from '../i18n/index.ts';
import { request } from '../api.ts';
import { button, el, field, input, row } from './dom.ts';

export function metadataFields(task?: Task): { node: HTMLElement; value: () => { due: string; tags: string[] } } {
  const due = input(task?.due ?? ''); due.type = 'date';
  const tags = input((task?.tags ?? []).join(', ')); tags.maxLength = 1982;
  return { node: row(field(t('tasks.due'), due), field(t('tasks.tags'), tags)), value: () => ({ due: due.value, tags: tags.value.split(',').map(s => s.trim()).filter(Boolean) }) };
}
export function metadataBadge(task: Task): HTMLElement {
  const node = el('span', overdue(task) ? 'warning' : 'muted');
  node.textContent = [task.due ? `${overdue(task) ? t('tasks.overdue') + ' ' : ''}${task.due}` : '', ...(task.tags ?? []).map(tag => `#${tag}`)].filter(Boolean).join(' · ');
  return node;
}
export function metadataEditor(project: string, task: Task, refresh: () => Promise<void>): HTMLElement {
  const fields = metadataFields(task);
  return row(fields.node, button(t('common.save'), async () => {
    await request('/api/task/update', { project, task: task.id, patch: fields.value() });
    await refresh();
  }));
}
