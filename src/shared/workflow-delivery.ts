import type { WorkflowPlan } from './workflow-graph.ts';
export interface WorkflowDelivery { state: 'blocked' | 'ready'; gates: { node: string; kind: 'verify' | 'review'; task?: string; ok: boolean; at?: string }[] }
/** Completion describes scheduler termination; delivery additionally requires explicit successful gates. */
export function workflowDelivery(plan: WorkflowPlan): WorkflowDelivery {
  const gates = plan.steps.filter(step => step.kind === 'verify' || step.kind === 'review').map(step => {
    const result = plan.results.findLast(result => result.node === step.id && !result.invalidatedAt);
    const kind = step.kind === 'verify' ? 'verify' : 'review';
    return { node: step.id!, kind: kind as 'verify' | 'review', task: result?.task, at: result?.at, ok: plan.nodeStates?.[step.id!] === 'succeeded' && result?.ok === true && (kind === 'verify' || result.approved === true) };
  });
  const verified = gates.some(gate => gate.kind === 'verify' && gate.ok);
  const reviewed = gates.some(gate => gate.kind === 'review' && gate.ok);
  const sameArtifact = gates.filter(gate => gate.ok).every(gate => gate.task === gates.find(gate => gate.kind === 'verify' && gate.ok)?.task);
  const terminalGates = plan.steps.filter(step => !plan.steps.some(next => next.dependsOn?.includes(step.id!))).every(step => step.kind === 'verify' || step.kind === 'review');
  return { state: plan.state === 'completed' && verified && reviewed && sameArtifact && terminalGates && gates.every(gate => gate.ok) ? 'ready' : 'blocked', gates };
}
