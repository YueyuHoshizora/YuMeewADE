import type { WorkflowTimeline, WorkflowEvent } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import { el } from './dom.ts';
import { localDateTime } from './display.ts';
const LABEL: Record<WorkflowEvent['type'], Parameters<typeof t>[0]> = {
  'run.started': 'workflow.start', 'run.finished': 'workflow.event.runFinished', 'run.interrupted': 'workflow.state.paused',
  'node.started': 'workflow.state.running', 'node.finished': 'workflow.output', 'node.invalidated': 'workflow.invalidated',
  'node.approved': 'workflow.approveHuman', 'integration.resolved': 'review.resolved',
};
// Run states and node states share one outcome field; unknown values stay visibly unknown instead of masquerading as paused.
const OUTCOME: Record<string, Parameters<typeof t>[0]> = {
  ready: 'workflow.state.ready', running: 'workflow.state.running', paused: 'workflow.state.paused', failed: 'workflow.state.failed', completed: 'workflow.state.completed',
  succeeded: 'verify.pass', conflict: 'verify.fail', pending: 'workflow.outcome.pending', human: 'workflow.outcome.human', skipped: 'workflow.outcome.skipped',
};
/** Display label of a run or node state; the stored value itself is never translated. */
export function workflowOutcome(value: string): string { return t(OUTCOME[value] ?? 'workflow.outcome.unknown'); }
export function renderWorkflowTimeline(plan: WorkflowTimeline): HTMLElement {
  const root = el('section', 'workflow-timeline'); root.append(el('h3', '', t('workflow.native.timeline')));
  const list = el('ol');
  for (const event of plan.events ?? []) {
    const item = el('li');
    const time = el('time', '', localDateTime(event.at)); time.dateTime = event.at;
    item.append(time, el('span', '', ` · #${event.sequence} · ${t(LABEL[event.type])} · ${event.run}${event.node ? ` · ${event.node}` : ''}${event.task ? ` · ${event.task}` : ''}${event.source ? ` · ${event.source}` : ''}`));
    if (event.outcome) item.append(el('span', '', ` · ${workflowOutcome(event.outcome)}`));
    if (event.request || event.snapshot) item.append(el('code', '', ` · ${event.request ?? ''}${event.snapshot ? ` · ${event.snapshot}` : ''}`));
    list.append(item);
  }
  root.append(list); return root;
}
