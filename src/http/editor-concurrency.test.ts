import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { EditorDocument, Project, Task, TerminalLease, ExecutionRun } from '../shared/types.ts';
import { startTestServer } from '../testing/server.ts';

test('terminal and dev processes permit editing while stale revisions preserve external writes', async () => {
  const server = await startTestServer();
  try {
    const project = (await server.api('POST', '/api/project/new', { name: 'ConcurrentEditor' })).json as Project;
    const task = (await server.api('POST', '/api/task/new', { project: project.id, title: 'Concurrent editor', workspace: 'direct' })).json as Task;
    const ids = { project: project.id, task: task.id };
    const file = path.join(await server.app.worktree.bodyPath(project.id), 'code.ts');
    await fs.writeFile(file, 'export const value = 1;\n');
    const read = async () => {
      const response = await server.api('GET', `/api/editor/file?project=${project.id}&task=${task.id}&path=code.ts`);
      assert.equal(response.status, 200);
      return response.json as EditorDocument;
    };
    const document = await read();
    const terminal = await server.api('POST', '/api/terminal/start', { ...ids, command: process.execPath, args: ['-e', 'process.stdin.resume()'] });
    assert.equal(terminal.status, 200);
    const lease = terminal.json as TerminalLease;
    try {
      const save = await server.api('POST', '/api/editor/save', { ...ids, path: 'code.ts', text: 'export const value = 2;\n', revision: document.revision });
      assert.equal(save.status, 200);
      assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 2;\n');
      const current = await read();
      await fs.writeFile(file, 'export const external = true;\n');
      assert.equal((await server.api('POST', '/api/editor/save', { ...ids, path: 'code.ts', text: 'lost', revision: current.revision })).status, 409);
      assert.equal(await fs.readFile(file, 'utf8'), 'export const external = true;\n');
      assert.equal((await server.api('POST', '/api/task/archive', { ...ids, force: true })).status, 409);
    } finally {
      assert.equal((await server.api('POST', '/api/terminal/stop', { ...ids, id: lease.session.id, owner: lease.owner })).status, 200);
    }
    const current = await read();
    const execution = await server.api('POST', '/api/execution/start', { ...ids, command: process.execPath, args: ['-e', 'process.stdin.resume()'] });
    assert.equal(execution.status, 200);
    const run = execution.json as ExecutionRun;
    try {
      assert.equal((await server.api('POST', '/api/editor/save', { ...ids, path: 'code.ts', text: 'export const development = true;\n', revision: current.revision })).status, 200);
      assert.equal(await fs.readFile(file, 'utf8'), 'export const development = true;\n');
    } finally { await server.api('POST', '/api/execution/stop', { ...ids, id: run.id }); }
  } finally { await server.close(); }
});
