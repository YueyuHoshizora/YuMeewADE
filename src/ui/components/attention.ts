import type { TaskView, ToolApproval } from '../../shared/types.ts';
export function attention(state: { projects: { id: string; tasks: Pick<TaskView, 'id' | 'title' | 'state' | 'question'>[] }[]; running: { project: string; task: string; approvals?: ToolApproval[] }[]; unread: { project: string; task: string }[] }): { project: string; task: string; title: string; kind: 'answer' | 'done' }[] {
  return state.projects.flatMap(project => project.tasks.flatMap(task => {
    const answer = state.running.some(r => r.project === project.id && r.task === task.id && !!r.approvals?.length) || task.state !== '完成' && (task.state === '等待回覆' || !!task.question);
    const finishedUnread = state.unread.some(entry => entry.project === project.id && entry.task === task.id) && !state.running.some(entry => entry.project === project.id && entry.task === task.id);
    return answer || finishedUnread ? [{ project: project.id, task: task.id, title: task.title, kind: answer ? 'answer' as const : 'done' as const }] : [];
  }));
}
