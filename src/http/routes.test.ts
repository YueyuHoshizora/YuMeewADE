import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { startTestServer } from '../testing/server.ts';
import type { AppState, Project, Task } from '../shared/types.ts';
import { MockCliProvider } from '../cli/mock.ts';

async function setup() {
  const server = await startTestServer('', { providers: { mock: new MockCliProvider(5) } });
  const project = (await server.api('POST', '/api/project/new', { name: 'Demo' })).json as Project;
  const task = (await server.api('POST', '/api/task/new', { project: project.id, title: 'First', phase: '計畫', steps: ['Implement'], cli: 'mock' })).json as Task;
  return { server, project, task };
}

test('state, completion approval and step hash continuation', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  const view = async () => ((await s.api('GET', '/api/state')).json as AppState).projects[0]!;
  try {
    assert.equal((await view()).tasks[0]!.confirm, false);
    assert.equal((await s.api('POST', '/api/task/step', { ...ids, index: 0, done: true })).status, 200);
    assert.equal((await view()).tasks[0]!.confirm, true);
    await s.api('POST', '/api/task/completion', { ...ids, action: 'continue' });
    assert.equal((await view()).tasks[0]!.confirm, false);
    await s.api('POST', '/api/task/step', { ...ids, add: 'Review' });
    await s.api('POST', '/api/task/step', { ...ids, index: 1, done: true });
    assert.equal((await view()).tasks[0]!.confirm, true);
    // External ledger completion requires approval, unlike the human update route.
    await s.app.tasks.update(p.id, t.id, { state: '完成' });
    assert.equal((await view()).tasks[0]!.confirm, true);
    await s.api('POST', '/api/task/completion', { ...ids, action: 'approve' });
    assert.equal((await view()).tasks[0]!.confirm, false);
    await s.api('POST', '/api/task/completion', { ...ids, action: 'continue' });
    assert.equal((await view()).tasks[0]!.state, '進行中');
    assert.equal(await s.app.completion.isApproved(p.id, t.id), false);
    await s.api('POST', '/api/task/update', { ...ids, patch: { state: '完成' } });
    assert.equal(await s.app.completion.isApproved(p.id, t.id), true);
    await s.api('POST', '/api/task/update', { ...ids, patch: { state: '暫停' } });
    assert.equal(await s.app.completion.isApproved(p.id, t.id), false);
    assert.equal((await s.api('POST', '/api/task/step', { ...ids, index: 0, done: 'yes' })).status, 400);
    assert.equal((await s.api('POST', '/api/task/completion', { ...ids, action: 'invalid' })).status, 400);
    assert.ok((await s.app.oplog.recent(200)).some((entry) => entry.action === 'task.approve'));
  } finally { await s.close(); }
});

test('phase offer, continuation key, legacy fallback, order and pins', async () => {
  const { server: s, project: p, task: t } = await setup();
  const state = async () => (await s.api('GET', '/api/state')).json as AppState;
  try {
    await s.api('POST', '/api/task/update', { project: p.id, task: t.id, patch: { state: '完成' } });
    assert.equal((await state()).projects[0]!.phaseOffer, true);
    await s.api('POST', '/api/phase/continue', { project: p.id });
    assert.equal((await state()).projects[0]!.phaseOffer, false);
    const next = (await s.api('POST', '/api/task/new', { project: p.id, title: 'Next', phase: '計畫' })).json as Task;
    await s.api('POST', '/api/task/update', { project: p.id, task: next.id, patch: { state: '完成' } });
    assert.equal((await state()).projects[0]!.phaseOffer, true);
    await s.api('POST', '/api/phase/next', { project: p.id });
    assert.equal((await state()).projects[0]!.currentPhase, '實作');
    assert.equal((await state()).projects[0]!.phaseOffer, false);
    await s.api('POST', '/api/task/update', { project: p.id, task: t.id, patch: { phase: '' } });
    await s.api('POST', '/api/task/update', { project: p.id, task: next.id, patch: { phase: '' } });
    assert.equal((await state()).projects[0]!.phaseOffer, true);
    const second = (await s.api('POST', '/api/project/new', { name: 'Other' })).json as Project;
    await s.api('POST', '/api/order', { parent: '', order: [second.id] });
    await s.api('POST', '/api/pin', { project: p.id, pinned: true });
    const result = await state();
    assert.deepEqual(result.order[''], [second.id, p.id]);
    assert.equal(result.projects.find((project) => project.id === p.id)!.pinned, true);
    assert.equal((await s.api('POST', '/api/pin', { project: p.id, pinned: 'true' })).status, 400);
    assert.equal((await s.api('GET', '/api/log?n=bad')).status, 400);
  } finally { await s.close(); }
});

test('archive copy guards, missing copy clear, memo and read', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  try {
    const copy = await s.app.worktree.prepare(p.id, t.id);
    assert.equal((await s.api('POST', '/api/task/archive', ids)).status, 409);
    assert.equal((await s.api('POST', '/api/project/archive', { project: p.id })).status, 409);
    assert.equal((await s.api('POST', '/api/task/copyclear', ids)).status, 409);
    await fs.rm(copy, { recursive: true, force: true });
    const before = (await s.api('GET', '/api/state')).json as AppState;
    assert.equal(before.projects[0]!.tasks[0]!.copyMissing, true);
    assert.equal((await s.api('POST', '/api/task/copyclear', ids)).status, 200);
    assert.equal((await s.app.tasks.get(p.id, t.id)).workdir, '');
    assert.equal((await s.api('POST', '/api/task/memo', { ...ids, text: 'A note' })).status, 200);
    assert.match((await s.app.tasks.get(p.id, t.id)).memo, /A note/);
    assert.equal((await s.api('POST', '/api/task/read', ids)).status, 200);
    assert.equal((await s.api('POST', '/api/task/archive', ids)).status, 200);
    assert.equal((await s.api('POST', '/api/project/archive', { project: p.id })).status, 200);
    assert.deepEqual(((await s.api('GET', '/api/state')).json as AppState).projects, []);
    assert.equal((await s.api('POST', '/api/open', { path: 'relative' })).status, 400);
  } finally { await s.close(); }
});

test('running archive/merge guards and unread read transition use mock provider', async () => {
  const s = await startTestServer('', { providers: { mock: new MockCliProvider({ chunkMs: 100, text: 'Completed mock response' }) } });
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Running' })).json as Project;
    const t = (await s.api('POST', '/api/task/new', { project: p.id, title: 'Work', cli: 'mock', workspace: 'direct' })).json as Task;
    const ids = { project: p.id, task: t.id };
    await s.app.runner.send({ ...ids, ai: 'mock', text: 'Run' });
    assert.equal((await s.api('POST', '/api/task/archive', ids)).status, 409);
    assert.equal((await s.api('POST', '/api/project/archive', { project: p.id })).status, 409);
    assert.equal((await s.api('POST', '/api/task/merge', ids)).status, 409);
    await s.app.runner.whenIdle();
    const state = (await s.api('GET', '/api/state')).json as AppState;
    assert.equal(state.projects[0]!.tasks[0]!.hasChat, true);
    assert.deepEqual(state.unread, [ids]);
    await s.api('POST', '/api/task/read', ids);
    assert.deepEqual(s.app.runner.unread(), []);
  } finally { await s.close(); }
});

test('HTTP gate rejects bad host/origin, malformed JSON and oversized bodies', async () => {
  const s = await startTestServer('limits:\n  bodyBytes: 100\n');
  const raw = (headers: Record<string, string>, chunks: string[]): Promise<number> => {
    const { promise, resolve } = Promise.withResolvers<number>();
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/project/new', method: 'POST', headers }, (res) => {
      res.resume(); resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(-1));
    for (const chunk of chunks) req.write(chunk);
    req.end();
    return promise;
  };
  try {
    assert.equal(await raw({ Host: 'evil.example:80' }, ['{}']), 403);
    assert.equal((await s.api('POST', '/api/project/new', { name: 'A' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await s.api('POST', '/api/project/new', '{bad')).status, 400);
    assert.equal((await s.api('POST', '/api/project/new', '[1]')).status, 400);
    assert.equal((await s.api('POST', '/api/project/new', { name: 'x'.repeat(200) })).status, 413);
    assert.equal(await raw({ 'Transfer-Encoding': 'chunked' }, ['{"name":"', 'y'.repeat(300), '"}']), 413);
  } finally { await s.close(); }
});
