import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withTmpWorkspace } from '../testing/tmp.ts';
import type { Workspace } from '../ledger/workspace.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { CompletionStore } from '../ledger/completion.ts';
import { WorktreeService } from '../git/worktree.ts';
import type { ChatRunner } from './runner.ts';
import { WorkflowService } from './workflows.ts';
import { ChatStore } from './store.ts';
import { normalizeGraph, validateGraph, downstreamNodes } from '../shared/workflow-graph.ts';
import type { WorkflowStep, ReviewResult } from '../shared/types.ts';

async function fixture(ws: Workspace, review: (p: string, t: string, input: { text: string }) => Promise<ReviewResult>, extra: Partial<ConstructorParameters<typeof WorkflowService>[0]> = {}) {
  const projects = new ProjectLedger(ws); await projects.create({ name: 'P' });
  const tasks = new TaskLedger(ws); const task = await tasks.create('P', { title: 'DAG' });
  const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: 100000 });
  let finished = Promise.withResolvers<void>();
  const workflow = new WorkflowService({ ws, tasks, completion: new CompletionStore(ws),
    store: new ChatStore(ws),
    runner: { isRunning: () => false, stop: async () => {}, send: async () => { throw new Error('unexpected writer'); } } as unknown as ChatRunner,
    available: async () => true, review, stopReview: () => false, beforeStart: async () => {},
    prepareBranch: async (p, t) => { await worktree.prepare(p, t); }, isTaskBusy: () => false, maxParallel: 2, promptChars: 10000,
    changed: () => { if (!workflow.isBusy('P', task.id)) finished.resolve(); },
    roles: async () => ({ roles: { expert: { main: { cli: 'mock', model: '', effort: '' }, job: '' }, human: { main: { cli: '人', model: '', effort: '' }, job: '' } } }),
    ...extra,
  });
  return { workflow, task, tasks, idle: () => finished.promise, reset: () => { finished = Promise.withResolvers<void>(); } };
}
const node = (id: string, dependsOn: string[] = [], extra: Partial<WorkflowStep> = {}): WorkflowStep => ({ id, dependsOn, role: 'expert', text: id, review: true, ...extra });

test('DAG validates references, cycles, branch conditions and downstream-only invalidation', () => {
  assert.equal(validateGraph(normalizeGraph([node('a'), node('b', ['a'])])), true);
  assert.equal(validateGraph(normalizeGraph([node('a', ['b']), node('b', ['a'])])), false);
  assert.equal(validateGraph(normalizeGraph([node('a'), node('a')])), false);
  assert.equal(validateGraph(normalizeGraph([node('a'), node('b', [], { condition: { node: 'a', outcome: 'failure' } })])), false);
  assert.deepEqual([...downstreamNodes(normalizeGraph([node('a'), node('b'), node('join', ['a', 'b'], { kind: 'join' })]), 'a')], ['a', 'join']);
});

test('valid node IDs that match object prototype names retain independent branch tasks', () => withTmpWorkspace(async ws => {
  const ids = ['constructor', '__proto__', 'toString'];
  const s = await fixture(ws, async (_project, task, input) => ({
    request: `request-${task}`, ai: 'mock', text: `handled:${input.text}`, ok: true, approved: true, structured: true,
  }));
  await s.workflow.configure('P', s.task.id, [], ids.map(id => node(id)));
  s.reset(); await s.workflow.start('P', s.task.id); await s.idle();
  const plan = await s.workflow.get('P', s.task.id);
  assert.equal(plan.state, 'completed');
  const branches = await Promise.all(ids.map(id => s.tasks.get('P', plan.branchTasks![id]!)));
  assert.equal(new Set(branches.map(task => task.workdir)).size, ids.length);
  for (const id of ids) {
    assert.equal(plan.nodeStates?.[id], 'succeeded');
    assert.equal(plan.results.find(result => result.node === id)?.output, `handled:${id}`);
  }
}));

test('independent experts overlap on actual separate worktrees and selected join consumes real outputs', () => withTmpWorkspace(async ws => {
  let active = 0; let max = 0; const both = Promise.withResolvers<void>(); const prompts: string[] = [];
  const s = await fixture(ws, async (_p, task, input) => {
    active++; max = Math.max(max, active); if (active === 2) both.resolve();
    if (input.text === 'a' || input.text === 'b') await both.promise;
    prompts.push(input.text); active--;
    return { request: `request-${task}`, ai: 'mock', text: `actual-${input.text === 'a' ? 'a' : input.text === 'b' ? 'b' : 'join'}`, ok: true, approved: true, structured: true };
  });
  await s.workflow.configure('P', s.task.id, [], [node('a'), node('b'), node('selected', ['a'], { condition: { node: 'a', outcome: 'approved' } }), node('rejected', ['a'], { condition: { node: 'a', outcome: 'failure' } }), node('join', ['b', 'selected', 'rejected'], { kind: 'join' })]);
  s.reset(); await s.workflow.start('P', s.task.id); await s.idle();
  const plan = await s.workflow.get('P', s.task.id);
  assert.equal(max, 2); assert.equal(plan.state, 'completed'); assert.equal(plan.nodeStates?.rejected, 'skipped');
  assert.ok(prompts.at(-1)?.includes('actual-b')); assert.ok(prompts.at(-1)?.includes('actual-join'));
  const a = await s.tasks.get('P', plan.branchTasks!.a!); const b = await s.tasks.get('P', plan.branchTasks!.b!);
  assert.notEqual(a.id, b.id); assert.notEqual(a.workdir, b.workdir); await fs.access(path.join(a.workdir, '.git')); await fs.access(path.join(b.workdir, '.git'));
  const rerun = await s.workflow.rerun('P', s.task.id, 0);
  assert.equal(rerun.nodeStates?.a, 'pending'); assert.equal(rerun.nodeStates?.b, 'succeeded'); assert.equal(rerun.nodeStates?.join, 'pending');
  assert.ok(rerun.results.find(r => r.node === 'a')?.invalidatedAt); assert.equal(rerun.results.find(r => r.node === 'b')?.invalidatedAt, undefined);
  await s.workflow.close();
}));

test('restart never authorizes execution and human evidence advances only a human-owned node', () => withTmpWorkspace(async ws => {
  let calls = 0; const s = await fixture(ws, async () => { calls++; throw new Error('unexpected review'); });
  const plan = await s.workflow.configure('P', s.task.id, [], [node('human', [], { role: 'human' })]);
  await fs.writeFile(path.join(ws.projectDir('P'), '.ai', 'workflows', `${s.task.id}.json`), JSON.stringify({ ...plan, state: 'running', nodeStates: { human: 'running' } }));
  assert.equal((await s.workflow.get('P', s.task.id)).state, 'paused'); assert.equal(calls, 0);
  s.reset(); await s.workflow.start('P', s.task.id); await s.idle();
  await assert.rejects(s.workflow.approveHuman('P', s.task.id, ''), { code: 'bad_request' });
  const approved = await s.workflow.approveHuman('P', s.task.id, 'Inspected real evidence', 'human');
  assert.equal(approved.state, 'completed'); assert.equal(approved.results.at(-1)?.approved, true); assert.equal(calls, 0);
}));

test('stop drains concurrent nodes and never starts a dependent without a new explicit start', () => withTmpWorkspace(async ws => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let calls = 0;
  const s = await fixture(ws, async (_p, task) => {
    calls++; entered.resolve(); await release.promise;
    return { request: task, ai: 'mock', text: 'controlled output', ok: true, approved: true, structured: true };
  });
  await s.workflow.configure('P', s.task.id, [], [node('a'), node('join', ['a'])]);
  s.reset(); await s.workflow.start('P', s.task.id); await entered.promise;
  const stopping = s.workflow.stop('P', s.task.id); release.resolve(); await stopping;
  const paused = await s.workflow.get('P', s.task.id);
  assert.equal(paused.state, 'paused'); assert.equal(paused.reason, 'workflow_stopped'); assert.equal(calls, 1);
  assert.equal(paused.nodeStates?.join, 'pending');
  await s.workflow.get('P', s.task.id); assert.equal(calls, 1);
}));

test('native failed verification blocks review and delivery; rerun invalidates downstream evidence', () => withTmpWorkspace(async ws => {
  let checks = 0; let reviews = 0;
  const s = await fixture(ws, async (_p, task) => {
    reviews++; return { request: task, ai: 'mock', text: 'reviewed', ok: true, approved: true, structured: true };
  }, { verify: async () => { checks++; return { ok: false, id: 'failed-build', output: 'build failed' }; }, currentVerification: async () => false });
  await s.workflow.configure('P', s.task.id, [], [node('edit'), node('build', ['edit'], { kind: 'verify', review: false }), node('review', ['build'], { kind: 'review', review: false })]);
  s.reset(); await s.workflow.start('P', s.task.id); await s.idle();
  const plan = await s.workflow.get('P', s.task.id);
  assert.equal(checks, 1); assert.equal(reviews, 1);
  assert.equal(plan.nodeStates?.build, 'failed'); assert.equal(plan.nodeStates?.review, 'skipped');
  assert.equal(plan.delivery?.state, 'blocked');
  const rerun = await s.workflow.rerun('P', s.task.id, 0, plan.revision);
  assert.ok(rerun.results.every(result => result.invalidatedAt)); assert.equal(rerun.nodeStates?.review, 'pending');
}));
