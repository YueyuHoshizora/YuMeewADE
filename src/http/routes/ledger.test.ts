import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestServer } from '../../testing/server.ts';
import type { Project, Task } from '../../shared/types.ts';

test('從範本建立的作業落在專案目前階段，而不是「無」', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Tpl', phases: ['計畫', '實作'] })).json as Project;
    const source = await s.app.tasks.create(p.id, { title: 'Source', phase: '計畫', steps: ['a'] });
    assert.equal((await s.api('POST', '/api/task/template/save', { project: p.id, task: source.id, name: 'tpl', scope: 'project' })).status, 200);
    assert.equal((await s.api('POST', '/api/phase/next', { project: p.id, phase: '計畫' })).status, 200);
    const created = await s.api('POST', '/api/task/template/create', { project: p.id, name: 'tpl', scope: 'project' });
    assert.equal(created.status, 200);
    assert.equal((created.json as { task: Task }).task.phase, '實作');
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
