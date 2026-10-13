import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestServer } from '../../testing/server.ts';
import type { Project } from '../../shared/types.ts';
import { MockCliProvider } from '../../cli/mock.ts';
import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { withFileLocks } from '../../shared/fsx.ts';

test('bulk validates whole request before writes and reports missing tasks independently', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Bulk' })).json as Project;
    const task = await s.app.tasks.create(p.id, { title: 'T', steps: ['keep'] });
    const bulk = (tasks: unknown, action: unknown) => s.api('POST', '/api/task/bulk', { project: p.id, tasks, action });
    for (const tasks of [[], 'bad', [42], [task.id, task.id], [task.id, '../bad'], Array.from({ length: 201 }, (_, i) => `t${i}`)]) {
      assert.equal((await bulk(tasks, { kind: 'state', value: '完成' })).status, 400);
    }
    for (const action of [null, { kind: 'unknown' }, { kind: 'state', value: 'bad' }, { kind: 'phase', value: 2 }, { kind: 'phase', value: 'x'.repeat(2001) }, { kind: 'due', value: '2026-02-30' }, { kind: 'addTag', value: ' leading' }, { kind: 'removeTag', value: '' }, { kind: 'archive' }]) {
      assert.equal((await bulk([task.id], action)).status, 400);
    }
    assert.equal((await s.app.tasks.get(p.id, task.id)).state, '未開始');
    const response = await bulk([task.id, 'missing'], { kind: 'state', value: '完成' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { results: [{ task: task.id, ok: true }, { task: 'missing', ok: false, error: 'not_found', detail: 'task_missing' }] });
    assert.equal(await s.app.completion.isApproved(p.id, task.id), true);
    await bulk([task.id], { kind: 'state', value: '暫停' });
    assert.equal(await s.app.completion.isApproved(p.id, task.id), false);
    await bulk([task.id], { kind: 'phase', value: 'new' });
    await bulk([task.id], { kind: 'due', value: '2028-02-29' });
    assert.equal((await s.app.tasks.get(p.id, task.id)).due, '2028-02-29');
    await bulk([task.id], { kind: 'due', value: '' });
    for (let i = 0; i < 2; i++) await bulk([task.id], { kind: 'addTag', value: 'a' });
    assert.deepEqual((await s.app.tasks.get(p.id, task.id)).tags, ['a']);
    for (let i = 0; i < 2; i++) await bulk([task.id], { kind: 'removeTag', value: 'a' });
    const read = await s.app.tasks.get(p.id, task.id);
    assert.deepEqual(read.tags, []); assert.equal(read.due, ''); assert.equal(read.phase, 'new'); assert.deepEqual(read.steps, [{ text: 'keep', done: false }]);
    assert.equal((await bulk(Array.from({ length: 200 }, (_, i) => `missing${i}`), { kind: 'phase', value: '' })).status, 200);
  } finally { await s.close(); }
});

test('bulk archive retains per-task running and working-copy safeguards', async () => {
  const s = await startTestServer('', { providers: { mock: new MockCliProvider(10) } });
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Archive' })).json as Project;
    const copyTask = await s.app.tasks.create(p.id, { title: 'copy' });
    const ordinary = await s.app.tasks.create(p.id, { title: 'ordinary' });
    await s.app.worktree.prepare(p.id, copyTask.id);
    const result = await s.api('POST', '/api/task/bulk', { project: p.id, tasks: [copyTask.id, ordinary.id], action: { kind: 'archive', confirm: true } });
    assert.deepEqual(result.json, { results: [{ task: copyTask.id, ok: false, error: 'conflict', detail: 'archive_has_worktree' }, { task: ordinary.id, ok: true }] });
    assert.equal(await s.app.worktree.exists(p.id, copyTask.id), true);
    assert.equal((await s.api('POST', '/api/task/archive', { project: p.id, task: copyTask.id, force: true })).status, 200);
    await assert.rejects(s.app.tasks.get(p.id, ordinary.id));
    const running = await s.app.tasks.create(p.id, { title: 'running', cli: 'mock', workspace: 'direct' });
    assert.equal((await s.api('POST', '/api/chat/send', { project: p.id, task: running.id, ai: 'mock', text: '[slow] go' })).status, 200);
    const blocked = await s.api('POST', '/api/task/bulk', { project: p.id, tasks: [running.id], action: { kind: 'archive', confirm: true } });
    assert.deepEqual(blocked.json, { results: [{ task: running.id, ok: false, error: 'conflict', detail: 'archive_while_running' }] });
    // Like the single-task update path, other human state changes still apply while a run is active; completion waits for it.
    assert.deepEqual((await s.api('POST', '/api/task/bulk', { project: p.id, tasks: [running.id], action: { kind: 'state', value: '暫停' } })).json, { results: [{ task: running.id, ok: true }] });
    assert.deepEqual((await s.api('POST', '/api/task/bulk', { project: p.id, tasks: [running.id], action: { kind: 'state', value: '完成' } })).json, { results: [{ task: running.id, ok: false, error: 'conflict', detail: 'complete_while_running' }] });
    assert.equal(await s.app.completion.isApproved(p.id, running.id), false);
    await s.api('POST', '/api/chat/stop', { project: p.id, task: running.id });
    await s.app.runner.whenIdle();
  } finally { await s.close(); }
});

for (const action of [{ kind: 'state', value: '暫停' }, { kind: 'archive', confirm: true }]) {
  test(`bulk ${action.kind} with corrupt completion data fails before changing the task`, async () => {
    const s = await startTestServer();
    try {
      const p = (await s.api('POST', '/api/project/new', { name: 'Corrupt bulk' })).json as Project;
      const task = await s.app.tasks.create(p.id, { title: 'unchanged' });
      await fs.writeFile(s.app.completion.file, '{broken');
      const response = await s.api('POST', '/api/task/bulk', { project: p.id, tasks: [task.id], action });
      assert.deepEqual(response.json, { results: [{ task: task.id, ok: false, error: 'internal', detail: 'file_corrupt' }] });
      assert.equal((await s.app.tasks.get(p.id, task.id)).state, '未開始');
    } finally { await s.close(); }
  });
}

test('bulk reports committed changes and publishes them when later completion bookkeeping fails', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Late bookkeeping' })).json as Project;
    const task = await s.app.tasks.create(p.id, { title: 'committed' });
    const update = s.app.tasks.update.bind(s.app.tasks);
    s.app.tasks.update = async (...args) => {
      const result = await update(...args);
      // A directory at the destination makes the atomic completion rename fail, after validation succeeded.
      await fs.mkdir(s.app.completion.file);
      return result;
    };
    const changes: string[] = [];
    const changed = s.app.changed.bind(s.app);
    s.app.changed = (project, id) => { if (id) changes.push(id); changed(project, id); };
    const response = await s.api('POST', '/api/task/bulk', { project: p.id, tasks: [task.id], action: { kind: 'state', value: '暫停' } });
    assert.deepEqual(response.json, { results: [{ task: task.id, ok: true }] });
    assert.equal((await s.app.tasks.get(p.id, task.id)).state, '暫停');
    assert.ok(changes.includes(task.id));
    assert.ok((await s.app.oplog.recent()).some(entry => entry.action === 'task.update' && entry.task === task.id));
  } finally { await s.close(); }
});

for (const endpoint of ['bulk', 'completion', 'update']) {
  test(`${endpoint} completion and AI admission cannot leave approval on an active turn`, async () => {
    const provider = new MockCliProvider(100);
    const s = await startTestServer('', { providers: { mock: provider } });
    const release = Promise.withResolvers<void>();
    let lock: Promise<void> | undefined;
    try {
      const p = (await s.api('POST', '/api/project/new', { name: `Admission ${endpoint}` })).json as Project;
      const task = await s.app.tasks.create(p.id, { title: 'race', cli: 'mock', workspace: 'direct' });
      const entered = Promise.withResolvers<void>();
      lock = withFileLocks([s.app.ws.taskFile(p.id, task.id)], async () => { entered.resolve(); await release.promise; });
      await entered.promise;
      const writing = Promise.withResolvers<void>();
      const update = s.app.tasks.update.bind(s.app.tasks);
      s.app.tasks.update = async (...args) => { if (args[2].state === '完成') writing.resolve(); return update(...args); };
      const approve = s.api('POST', `/api/task/${endpoint}`, {
        project: p.id, task: task.id,
        ...(endpoint === 'bulk' ? { tasks: [task.id], action: { kind: 'state', value: '完成' } }
          : endpoint === 'update' ? { patch: { state: '完成' } } : { action: 'approve' }),
      });
      await Promise.race([writing.promise, approve.then(response => { throw new Error(`approval ended before write: ${JSON.stringify(response)}`); })]);
      const send = s.api('POST', '/api/chat/send', { project: p.id, task: task.id, ai: 'mock', text: '[slow] work' });
      await delay(50);
      release.resolve();
      await lock;
      assert.equal((await approve).status, 200);
      assert.equal((await send).status, 200);
      assert.equal(s.app.aiBusy(p.id, task.id), true);
      assert.equal(await s.app.completion.isApproved(p.id, task.id), false);
      await s.api('POST', '/api/chat/stop', { project: p.id, task: task.id });
      await s.app.runner.whenIdle();
    } finally { release.resolve(); await lock; await s.close(); }
  });
}
