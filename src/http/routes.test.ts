import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { startTestServer } from '../testing/server.ts';
import type { Bootstrap, Task } from '../shared/types.ts';

test('非對話端點：bootstrap → 建專案 → 建作業 → 更新 → 清單', async () => {
  const s = await startTestServer();
  try {
    const boot = await s.api('GET', '/api/bootstrap');
    assert.equal(boot.status, 200);
    const b = boot.json as Bootstrap;
    assert.deepEqual(b.projects, []);
    assert.ok(b.roles.roles['實作']);
    assert.equal(b.limits.promptChars, 10_000);

    assert.equal((await s.api('POST', '/api/projects', { name: 'Demo' })).status, 200);
    assert.equal((await s.api('POST', '/api/projects', { name: 'demo' })).status, 409);
    assert.equal((await s.api('POST', '/api/projects', { name: '../x' })).status, 400);
    assert.equal((await s.api('POST', '/api/projects', {})).status, 400);

    const created = await s.api('POST', '/api/tasks', { project: 'Demo', title: '第一件', role: '實作' });
    assert.equal(created.status, 200);
    const t = created.json as Task;
    assert.equal(t.role, '實作');
    assert.equal((await s.api('POST', '/api/tasks', { project: 'Demo', title: 'x', role: '不存在' })).status, 400);
    assert.equal((await s.api('POST', '/api/tasks', { project: 'Nope', title: 'x' })).status, 404);

    const upd = await s.api('POST', '/api/task/update', { project: 'Demo', task: t.id, patch: { state: '進行中', owner: 'codex' } });
    assert.equal(upd.status, 200);
    assert.equal((upd.json as Task).state, '進行中');
    assert.equal((await s.api('POST', '/api/task/update', { project: 'Demo', task: t.id, patch: { state: 1 } })).status, 400);
    assert.equal((await s.api('POST', '/api/task/update', { project: 'Demo', task: 'zz', patch: { state: '完成' } })).status, 404);

    const list = await s.api('GET', `/api/tasks?project=Demo`);
    assert.equal(list.status, 200);
    assert.equal((list.json as Task[]).length, 1);
    assert.equal((await s.api('GET', '/api/tasks')).status, 400);
    assert.equal((await s.api('GET', '/api/nothing')).status, 404);
  } finally {
    await s.close();
  }
});

test('閘門：Host／Origin 不符回 403，壞 JSON 回 400，過大回 413', async () => {
  const s = await startTestServer('limits:\n  bodyBytes: 100\n');
  const raw = (headers: Record<string, string>, chunks: string[]): Promise<number> => {
    const { promise, resolve } = Promise.withResolvers<number>();
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/projects', method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(-1));
    for (const c of chunks) req.write(c);
    req.end();
    return promise;
  };
  try {
    // fetch 不允許改 Host，改用 http.request
    assert.equal(await raw({ Host: 'evil.example:80', 'Content-Type': 'application/json' }, ['{"name":"A"}']), 403);
    assert.equal((await s.api('POST', '/api/projects', { name: 'A' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await s.api('POST', '/api/projects', { name: 'A' }, { Origin: s.base })).status, 200);
    assert.equal((await s.api('POST', '/api/projects', '{bad')).status, 400);
    assert.equal((await s.api('POST', '/api/projects', '[1]')).status, 400);
    assert.equal((await s.api('POST', '/api/projects', { name: 'x'.repeat(200) })).status, 413);
    // 不帶 Content-Length 的分塊上傳也要擋
    assert.equal(await raw({ 'Transfer-Encoding': 'chunked' }, ['{"name":"', 'y'.repeat(300), '"}']), 413);
  } finally {
    await s.close();
  }
});
