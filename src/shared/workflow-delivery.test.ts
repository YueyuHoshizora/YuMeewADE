import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowDelivery } from './workflow-delivery.ts';
import type { WorkflowPlan } from './workflow-graph.ts';
test('scheduler completion cannot substitute for same-artifact successful verify and review gates', () => {
  const plan: WorkflowPlan = { dependencies: [], steps: [{ id: 'verify', kind: 'verify', dependsOn: [], role: 'expert', text: 'build', review: false }, { id: 'review', kind: 'review', dependsOn: ['verify'], role: 'expert', text: 'review', review: false }], cursor: 2, state: 'completed', nodeStates: { verify: 'succeeded', review: 'succeeded' }, results: [{ node: 'verify', role: 'expert', ai: 'verify', request: 'v', at: '2026-10-12T00:00:00Z', ok: true, task: 'candidate' }, { node: 'review', role: 'expert', ai: 'review', request: 'r', at: '2026-10-12T00:01:00Z', ok: true, approved: true, task: 'candidate' }] };
  assert.equal(workflowDelivery(plan).state, 'ready');
  plan.results[0]!.ok = false; assert.equal(workflowDelivery(plan).state, 'blocked');
  plan.results[0]!.ok = true; plan.results[1]!.task = 'different'; assert.equal(workflowDelivery(plan).state, 'blocked');
  plan.results[1]!.task = 'candidate'; plan.results[0]!.invalidatedAt = 'later'; assert.equal(workflowDelivery(plan).state, 'blocked');
  delete plan.results[0]!.invalidatedAt;
  plan.steps.push({ id: 'late-write', kind: 'expert', dependsOn: ['review'], role: 'expert', text: 'edit', review: false });
  assert.equal(workflowDelivery(plan).state, 'blocked');
});
