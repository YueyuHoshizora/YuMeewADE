import { TASK_STATES, type Task } from '../../shared/types.ts';
import { overdue, today } from '../../shared/task-metadata.ts';

export interface TaskSelection { view: 'list' | 'board'; sort: 'updated' | 'due' | 'title' | 'state'; tag: string; state: string; ai: string; overdue: boolean; text: string }
export function taskSelection(value: unknown): TaskSelection {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const text = (key: string) => typeof raw[key] === 'string' ? (raw[key] as string).slice(0, 200) : '';
  return { view: raw.view === 'board' ? 'board' : 'list', sort: ['updated', 'due', 'title', 'state'].includes(String(raw.sort)) ? raw.sort as TaskSelection['sort'] : 'updated', tag: text('tag'), state: TASK_STATES.some(s => s === raw.state) ? text('state') : '', ai: text('ai'), overdue: raw.overdue === true, text: text('text') };
}
export function selectTasks<T extends Task>(tasks: readonly T[], selection: TaskSelection, day = today()): T[] {
  const term = selection.text.trim().toLocaleLowerCase();
  return tasks.filter(task => (!selection.tag || task.tags?.includes(selection.tag)) && (!selection.state || task.state === selection.state) && (!selection.ai || task.cli === selection.ai) && (!selection.overdue || overdue(task, day)) && (!term || [task.title, task.id, ...(task.tags ?? [])].some(text => text.toLocaleLowerCase().includes(term)))).sort((a, b) => {
    let order = 0;
    switch (selection.sort) {
      case 'updated': order = b.updated.localeCompare(a.updated); break;
      case 'due': order = (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99'); break;
      case 'title': order = a.title.localeCompare(b.title); break;
      case 'state': order = TASK_STATES.indexOf(a.state) - TASK_STATES.indexOf(b.state); break;
    }
    return order || a.id.localeCompare(b.id, 'en', { numeric: true });
  });
}
