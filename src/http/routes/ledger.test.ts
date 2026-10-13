import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startTestServer } from '../../testing/server.ts';
import type { Project, Task } from '../../shared/types.ts';

test('fresh projects have no phases and omitted task phases stay blank after opting into planning', async () => {
  const s = await startTestServer();
  try {
    const created = await s.api('POST', '/api/project/new', { name: 'Default' });
    assert.equal(created.status, 200);
    const project = await s.app.projects.get('Default');
    assert.deepEqual(project.phases, []);
    const loose = await s.api('POST', '/api/task/new', { project: project.id, title: 'Unassigned', workspace: 'direct' });
    assert.equal(loose.status, 200);
    const task = (await s.app.tasks.list(project.id))[0]!;
    assert.equal(task.phase, '');
    await s.api('POST', '/api/task/update', { project: project.id, task: task.id, patch: { state: '完成' } });
    s.app.changed();
    const initial = (await s.app.state()).projects.find(item => item.id === project.id)!;
    assert.equal(initial.currentPhase, '');
    assert.equal(initial.phaseOffer, false);
    assert.equal((await s.api('POST', '/api/project/phases', { project: project.id, previous: [], phases: [{ name: 'Plan' }] })).status, 200);
    assert.equal((await s.api('POST', '/api/task/new', { project: project.id, title: 'Still unassigned', workspace: 'direct' })).status, 200);
    assert.equal((await s.app.tasks.list(project.id)).find(item => item.title === 'Still unassigned')!.phase, '');
    assert.equal((await s.api('POST', '/api/task/new', { project: project.id, title: 'Assigned', phase: 'Plan', workspace: 'direct' })).status, 200);
    assert.equal((await s.app.tasks.list(project.id)).find(item => item.title === 'Assigned')!.phase, 'Plan');
    assert.equal((await s.api('POST', '/api/task/new', { project: project.id, title: 'Invalid', phase: 42 })).status, 400);
  } finally { await s.close(); }
});

test('template-created tasks remain unassigned even in an active phased project', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Tpl', phases: ['計畫', '實作'] })).json as Project;
    const source = await s.app.tasks.create(p.id, { title: 'Source', phase: '計畫', steps: ['a'] });
    assert.equal((await s.api('POST', '/api/task/template/save', { project: p.id, task: source.id, name: 'tpl', scope: 'project' })).status, 200);
    assert.equal((await s.api('POST', '/api/phase/next', { project: p.id, phase: '計畫' })).status, 200);
    const created = await s.api('POST', '/api/task/template/create', { project: p.id, name: 'tpl', scope: 'project' });
    assert.equal(created.status, 200);
    assert.ok(created.json && typeof created.json === 'object' && 'task' in created.json);
    const task = created.json.task;
    assert.ok(task && typeof task === 'object' && 'phase' in task);
    assert.equal(task.phase, '');
  } finally { await s.close(); }
});

test('two phase renames in a row move the tasks all the way, even when the first is still migrating', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Ph', phases: ['A'] })).json as Project;
    const task = await s.app.tasks.create(p.id, { title: 'T', phase: 'A' });
    // Hold the first request's task migration until the second one has been sent.
    const list = s.app.tasks.list.bind(s.app.tasks); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); let calls = 0;
    s.app.tasks.list = async (...args: Parameters<typeof list>) => { if (++calls === 1) { entered.resolve(); await gate.promise; } return list(...args); };
    const first = s.api('POST', '/api/project/phases', { project: p.id, previous: ['A'], phases: [{ name: 'B', from: 'A' }] });
    await entered.promise;
    const second = s.api('POST', '/api/project/phases', { project: p.id, previous: ['B'], phases: [{ name: 'C', from: 'B' }] });
    await new Promise(resolve => setTimeout(resolve, 50)); gate.resolve();
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    assert.deepEqual((await s.app.projects.get(p.id)).phases.map(phase => phase.name), ['C']);
    assert.equal((await s.app.tasks.get(p.id, task.id)).phase, 'C');
  } finally { await s.close(); }
});

test('the main folder cannot move to another folder while tasks still have working copies of the current one', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Body' })).json as Project;
    const task = await s.app.tasks.create(p.id, { title: 'T' });
    await s.app.worktree.prepare(p.id, task.id);
    const other = path.join(s.dir, 'other'); await fs.mkdir(other);
    const moved = await s.api('POST', '/api/project/update', { project: p.id, patch: { body: other } });
    assert.equal(moved.status, 409); assert.equal((moved.json as { detail?: string }).detail, 'body_has_worktrees');
    assert.equal((await s.app.projects.get(p.id)).body ?? '', '');
    // The same folder (spelled out) and other fields stay editable.
    assert.equal((await s.api('POST', '/api/project/update', { project: p.id, patch: { body: s.app.ws.projectDir(p.id), description: 'kept' } })).status, 200);
    await s.app.worktree.abandon(p.id, task.id);
    assert.equal((await s.api('POST', '/api/project/update', { project: p.id, patch: { body: other } })).status, 200);
  } finally { await s.close(); }
});
