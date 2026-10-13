import type { Busy, ChatRow, TaskView } from '../../shared/types.ts';

export type TaskActivity = 'running' | 'waiting' | 'error' | 'idle' | 'completed';

/** Activity describes execution, not readiness or the AI's unreviewed completion claim. */
export function taskActivity(task: Pick<TaskView, 'question' | 'state' | 'confirm'>, busy: Pick<Busy, 'approvals'> | null, latest?: ChatRow): TaskActivity {
  if (task.question || busy?.approvals?.length) return 'waiting';
  if (busy) return 'running';
  if (latest?.role === 'assistant' && latest.error) return 'error';
  if (task.state === '完成' && !task.confirm) return 'completed';
  return 'idle';
}
