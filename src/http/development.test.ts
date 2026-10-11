import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ArchiveEntry, EditorDocument, Project, Task } from '../shared/types.ts';
import { startTestServer } from '../testing/server.ts';
import { MockCliProvider } from '../cli/mock.ts';

test('task archive queries and restore preserve the correct task and conversation', async () => {
  const server = await startTestServer();
  try {
    const project = (await server.api('POST', '/api/project/new', { name: 'Archive' })).json as Project;
    const task = (await server.api('POST', '/api/task/new', { project: project.id, title: 'Saved task', workspace: 'direct' })).json as Task;
    const ids = { project: project.id, task: task.id };
    const chat = path.join(server.app.ws.projectDir(project.id), '.ai', 'chat', `${task.id}.jsonl`);
    await fs.writeFile(chat, '{"preserved":"conversation"}\n');
    assert.equal((await server.api('POST', '/api/task/archive', ids)).status, 200);
    const entries = (await server.api('GET', `/api/archive/list?project=${project.id}`)).json as ArchiveEntry[];
    assert.equal(entries.length, 1); assert.equal(entries[0]!.task, task.id);
    assert.deepEqual((await server.api('GET', '/api/archive/list')).json, []);
    assert.equal((await server.api('POST', '/api/archive/restore', { project: project.id, key: entries[0]!.key })).status, 200);
    assert.equal((await server.app.tasks.get(project.id, task.id)).title, 'Saved task');
    assert.equal(await fs.readFile(chat, 'utf8'), '{"preserved":"conversation"}\n');
    assert.deepEqual((await server.api('GET', `/api/archive/list?project=${project.id}`)).json, []);
  } finally { await server.close(); }
});

test('editor HTTP conflicts do not overwrite external edits and snapshot reservation rejects mutations', async () => {
  const server = await startTestServer();
  try {
    const project = (await server.api('POST', '/api/project/new', { name: 'Edit' })).json as Project;
    const file = path.join(await server.app.worktree.bodyPath(project.id), 'code.ts');
    await fs.writeFile(file, 'export const value = 1;\n');
    const document = (await server.api('GET', `/api/editor/file?project=${project.id}&path=code.ts`)).json as EditorDocument;
    await fs.writeFile(file, 'export const value = 2;\n');
    const conflict = await server.api('POST', '/api/editor/save', { project: project.id, path: 'code.ts', text: 'lost edit', revision: document.revision });
    assert.equal(conflict.status, 409);
    assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 2;\n');
    const hold = Promise.withResolvers<void>();
    const reserved = server.app.mutations.exclusive(() => false, () => hold.promise);
    try {
      assert.equal((await server.api('POST', '/api/project/update', { project: project.id, patch: { description: 'late mutation' } })).status, 409);
      assert.equal((await server.api('GET', '/api/care/health')).status, 409);
    } finally { hold.resolve(); await reserved; }
    assert.equal((await server.app.projects.get(project.id)).description, '');
    assert.equal((await server.api('POST', '/api/project/update', { project: project.id, patch: { description: 'admitted' } })).status, 200);
    assert.equal((await server.app.projects.get(project.id)).description, 'admitted');
  } finally { await server.close(); }
});

test('chat preflight excludes command and archive mutations before provider availability resolves', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const mock = new MockCliProvider(1);
  const server = await startTestServer('', { providers: { mock: {
    name: 'mock', dangerous: false,
    available: async () => { entered.resolve(); await release.promise; return true; },
    send: (options, onEvent) => mock.send(options, onEvent),
  } } });
  const project = await server.app.projects.create({ name: 'Reserved' });
  const task = await server.app.tasks.create(project.id, { title: 'preflight' });
  const sending = server.app.runner.send({ project: project.id, task: task.id, ai: 'mock', text: 'go' });
  try {
    await entered.promise;
    await assert.rejects(server.app.execution.start(project.id, task.id, {
      command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
    }), { status: 409 });
    assert.equal((await server.api('POST', '/api/task/archive', { project: project.id, task: task.id, force: true })).status, 409);
  } finally { release.resolve(); await sending; await server.close(); }
});
