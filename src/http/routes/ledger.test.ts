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
