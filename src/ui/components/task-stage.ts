import type { Busy, TaskView } from '../../shared/types.ts';

export type TaskStage = 'prepare' | 'running' | 'attention' | 'review' | 'continue';

/** Live work takes precedence over a ledger completion claim; questions still require human attention. */
export function taskStage(task: Pick<TaskView, 'question' | 'confirm' | 'state' | 'hasChat'>, busy: Pick<Busy, 'approvals'> | null): TaskStage {
  if (task.question || busy?.approvals?.length) return 'attention';
  if (busy) return 'running';
  if (task.confirm || task.state === '完成') return 'review';
  if (!task.hasChat && task.state === '未開始') return 'prepare';
  return 'continue';
}
