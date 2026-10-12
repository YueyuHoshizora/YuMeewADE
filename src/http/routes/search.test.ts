import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project, SearchResult, Task } from '../../shared/types.ts';
import { startTestServer } from '../../testing/server.ts';

test('search can be scoped to one task or project without leaking other conversations', async () => {
  const s = await startTestServer();
  try {
    const one = (await s.api('POST', '/api/project/new', { name: 'One' })).json as Project;
    const two = (await s.api('POST', '/api/project/new', { name: 'Two' })).json as Project;
    const tasks: Task[] = [];
    for (const [project, title] of [[one, 'A'], [one, 'B'], [two, 'C']] as const) {
      const task = (await s.api('POST', '/api/task/new', { project: project.id, title, cli: 'mock', workspace: 'direct' })).json as Task;
      assert.equal((await s.api('POST', '/api/chat/send', { project: project.id, task: task.id, ai: 'mock', text: 'needle here' })).status, 200);
      await s.app.runner.whenIdle(); tasks.push(task);
    }
    // The mock reply echoes the instruction, so count each task once through its user row.
    const found = async (params: string) => ((await s.api('GET', `/api/search?q=needle${params}`)).json as SearchResult).hits.filter(hit => hit.kind === 'chat' && hit.role === 'user').map(hit => `${hit.project}/${hit.task}`).sort();
    assert.equal((await found('')).length, 3);
    assert.deepEqual(await found(`&project=${one.id}`), [`${one.id}/${tasks[0]!.id}`, `${one.id}/${tasks[1]!.id}`].sort());
    assert.deepEqual(await found(`&project=${one.id}&task=${tasks[1]!.id}`), [`${one.id}/${tasks[1]!.id}`]);
    // A task scope needs its project, and unknown or unsafe names are rejected rather than widening the search.
    assert.equal((await s.api('GET', `/api/search?q=needle&task=${tasks[1]!.id}`)).status, 400);
    assert.equal((await s.api('GET', `/api/search?q=needle&project=${one.id}&task=20991231-999`)).status, 404);
    assert.equal((await s.api('GET', '/api/search?q=needle&project=NoSuch')).status, 404);
    assert.equal((await s.api('GET', '/api/search?q=needle&project=..%2FTwo')).status, 400);
  } finally { await s.close(); }
});
