import type { IntegrationCandidate } from '../git/workflow-integration.ts';
import type { WorkflowDelivery } from './workflow-delivery.ts';
export interface WorkflowStep { role: string; text: string; review: boolean; id?: string; dependsOn?: string[]; upstream?: string[]; condition?: { node: string; outcome: 'success' | 'approved' | 'failure' }; kind?: 'expert' | 'join' | 'integration' | 'verify' | 'review' }
export interface WorkflowResult { role: string; ai: string; request: string; at: string; ok: boolean; step?: number; node?: string; task?: string; invalidatedAt?: string; output?: string; approved?: boolean; evidence?: string; reviewSnapshot?: string }
export type WorkflowNodeState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'human';
export interface WorkflowPlan { dependencies: string[]; steps: WorkflowStep[]; cursor: number; state: 'ready' | 'running' | 'paused' | 'failed' | 'completed'; results: WorkflowResult[]; reason?: string; revision?: number; nodeStates?: Record<string, WorkflowNodeState>; branchTasks?: Record<string, string>; candidates?: Record<string, IntegrationCandidate>; delivery?: WorkflowDelivery }

/** Missing graph fields are the old linear schema, not implicitly parallel. */
export function normalizeGraph(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((step, index) => ({ ...step, id: step.id ?? `step-${index + 1}`, dependsOn: step.dependsOn ?? (index ? [steps[index - 1]?.id ?? `step-${index}`] : []), kind: step.kind ?? 'expert' }));
}
export function validateGraph(steps: WorkflowStep[]): boolean {
  const nodes = new Map(steps.map(step => [step.id, step]));
  if (nodes.size !== steps.length) return false;
  const visited = new Set<string>(); const active = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    const step = nodes.get(id); if (!step || !/^[a-zA-Z0-9_-]{1,80}$/u.test(id) || !Array.isArray(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length) return false;
    if (!['expert', 'join', 'integration', 'verify', 'review'].includes(step.kind!)) return false;
    if (step.upstream && (!Array.isArray(step.upstream) || new Set(step.upstream).size !== step.upstream.length || step.upstream.some(id => !step.dependsOn!.includes(id)))) return false;
    if (step.kind === 'integration' && !step.upstream?.length) return false;
    if ((step.kind === 'verify' || step.kind === 'review') && step.dependsOn.length !== 1) return false;
    if (step.condition && (!step.dependsOn.includes(step.condition.node) || !['success', 'approved', 'failure'].includes(step.condition.outcome))) return false;
    if (step.kind === 'join' && step.dependsOn.length < 2) return false;
    active.add(id);
    for (const dependency of step.dependsOn) if (typeof dependency !== 'string' || !visit(dependency)) return false;
    active.delete(id); visited.add(id); return true;
  };
  return steps.every(step => typeof step.id === 'string' && visit(step.id));
}
export function downstreamNodes(steps: WorkflowStep[], from: string): Set<string> {
  const affected = new Set([from]); let changed = true;
  while (changed) { changed = false; for (const step of steps) if (!affected.has(step.id!) && step.dependsOn?.some(id => affected.has(id))) { affected.add(step.id!); changed = true; } }
  return affected;
}
