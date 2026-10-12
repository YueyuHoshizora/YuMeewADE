import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendWorkflowEvent, WORKFLOW_EVENT_LIMIT, type WorkflowTimeline } from './workflow-timeline.ts';
test('bounded timeline keeps real source identity and monotonic checkpoints across restart', () => {
  let plan: WorkflowTimeline = { runId: 'actual-run' };
  for (let index = 0; index < WORKFLOW_EVENT_LIMIT + 20; index++) appendWorkflowEvent(plan, { type: 'node.finished', node: 'verify', source: 'verify', task: 'branch', request: `check-${index}`, outcome: index % 2 ? 'failed' : 'succeeded' }, new Date(index * 1000).toISOString());
  assert.equal(plan.events?.length, WORKFLOW_EVENT_LIMIT); assert.equal(plan.events?.[0]?.sequence, 21);
  plan = JSON.parse(JSON.stringify(plan)) as WorkflowTimeline;
  const event = appendWorkflowEvent(plan, { type: 'run.interrupted', outcome: 'paused' });
  assert.equal(event.sequence, WORKFLOW_EVENT_LIMIT + 21); assert.equal(event.run, 'actual-run');
  assert.equal(plan.events?.at(-2)?.request, `check-${WORKFLOW_EVENT_LIMIT + 19}`);
  assert.equal(plan.events?.at(-2)?.source, 'verify');
  assert.equal(plan.events?.at(-2)?.task, 'branch');
  assert.equal(plan.events?.at(-2)?.outcome, 'failed');
});
