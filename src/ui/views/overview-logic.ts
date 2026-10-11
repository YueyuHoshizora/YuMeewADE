import { TASK_STATES, type AppState, type ProjectView, type TaskView, type TaskState } from '../../shared/types.ts';
import { overdue, today } from '../../shared/task-metadata.ts';
import { attention } from '../components/attention.ts';

export type OverviewState = Pick<AppState, 'projects' | 'running' | 'unread'>;
export interface OverviewTask { project: ProjectView; task: TaskView }

/** Dates are local calendar days, not elapsed 24-hour intervals (including DST). */
export function aggregateOverview(state: OverviewState, tag = '', now = new Date()) {
  const day = today(now); const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
  const lastDay = today(end);
  // Archived ledgers are absent from /api/state; stale runtime references must not reintroduce them.
  const tasks = state.projects.flatMap(project => project.tasks.filter(task => !tag || task.tags?.includes(tag)).map(task => ({ project, task })));
  const totals = Object.fromEntries(TASK_STATES.map(state => [state, 0])) as Record<TaskState, number>;
  for (const { task } of tasks) totals[task.state]++;
  const answers = new Set(attention(state).filter(item => item.kind === 'answer').map(item => JSON.stringify([item.project, item.task])));
  const running = new Set(state.running.map(item => JSON.stringify([item.project, item.task])));
  const unread = new Set(state.unread.map(item => JSON.stringify([item.project, item.task])));
  const key = (item: OverviewTask) => JSON.stringify([item.project.id, item.task.id]);
  const byDue = (a: OverviewTask, b: OverviewTask) => (a.task.due ?? '').localeCompare(b.task.due ?? '');
  return {
    tasks, totals,
    tags: [...new Set(state.projects.flatMap(project => project.tasks.flatMap(task => task.tags ?? [])))].sort(),
    overdue: tasks.filter(({ task }) => overdue(task, day)).sort(byDue),
    upcoming: tasks.filter(({ task }) => task.state !== '完成' && !!task.due && task.due >= day && task.due <= lastDay).sort(byDue),
    waiting: tasks.filter(item => answers.has(key(item)) || item.task.confirm),
    running: tasks.filter(item => running.has(key(item))),
    unread: tasks.filter(item => unread.has(key(item))),
    projects: state.projects.flatMap(project => {
      const selected = project.tasks.filter(task => !tag || task.tags?.includes(tag));
      return tag && !selected.length ? [] : [{ project, total: selected.length, done: selected.filter(task => task.state === '完成').length }];
    }),
  };
}
