export interface WorkflowEvent { sequence: number; at: string; run: string; type: 'run.started' | 'run.finished' | 'run.interrupted' | 'node.started' | 'node.finished' | 'node.invalidated' | 'node.approved' | 'integration.resolved'; node?: string; task?: string; source?: string; outcome?: string; request?: string; snapshot?: string }
export interface WorkflowTimeline { events?: WorkflowEvent[]; eventSequence?: number; runId?: string }
export const WORKFLOW_EVENT_LIMIT = 500;
/** Sequence numbers survive eviction and restart; timestamps represent actual observed transitions. */
export function appendWorkflowEvent(plan: WorkflowTimeline, event: Omit<WorkflowEvent, 'sequence' | 'at' | 'run'>, at = new Date().toISOString()): WorkflowEvent {
  const row: WorkflowEvent = { ...event, sequence: (plan.eventSequence ?? 0) + 1, at, run: plan.runId ?? 'configuration' };
  plan.eventSequence = row.sequence; plan.events ??= []; plan.events.push(row);
  if (plan.events.length > WORKFLOW_EVENT_LIMIT) plan.events.splice(0, plan.events.length - WORKFLOW_EVENT_LIMIT);
  return row;
}
