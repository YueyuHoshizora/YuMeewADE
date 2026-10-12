import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project, Task } from '../../shared/types.ts';
import { startTestServer } from '../../testing/server.ts';

test('proposal generation and workflow start share the per-source AI send budget with chat', async () => {
  const s = await startTestServer('limits:\n  sendPerMinute: 1\n');
  try {
    const project = (await s.api('POST', '/api/project/new', { name: 'Limited' })).json as Project;
    const task = (await s.api('POST', '/api/task/new', { project: project.id, title: 'Work', cli: 'mock', workspace: 'direct' })).json as Task;
    assert.equal((await s.api('POST', '/api/chat/send', { project: project.id, task: task.id, ai: 'mock', text: 'first' })).status, 200);
    await s.app.runner.whenIdle();
    const proposal = await s.api('POST', '/api/editor/proposals/generate', { project: project.id, task: task.id, ai: 'mock', instruction: 'edit', files: [{ path: 'a.ts', revision: 'r', text: '', selection: { from: 0, to: 0 } }] });
    assert.equal(proposal.status, 429);
    const workflow = await s.api('POST', '/api/task/workflow/start', { project: project.id, task: task.id });
    assert.equal(workflow.status, 429);
  } finally { await s.close(); }
});
