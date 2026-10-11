import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { startTestServer } from '../../testing/server.ts';

test('terminal recovery cookie, renderer, origin and workspace boundaries fail closed', async () => {
  const server = await startTestServer();
  try {
    await server.app.projects.create({ name: 'Recovery' });
    const task = await server.app.tasks.create('Recovery', { title: 'Recovery', workspace: 'direct' });
    const lease = await server.app.terminal.start('Recovery', task.id, { command: process.execPath, args: ['-e', 'process.stdin.resume()'] });
    async function init(): Promise<string> {
      const response = await fetch(`${server.base}/api/terminal/recovery/init`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.base }, body: '{}' });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie'); assert.ok(cookie);
      assert.match(cookie, /HttpOnly/u); assert.match(cookie, /SameSite=Strict/u); assert.match(cookie, /Path=\/api\/terminal/u); assert.match(cookie, /Max-Age=86400/u);
      return cookie.split(';')[0]!;
    }
    const cookie = await init(); const otherCookie = await init(); const renderer = 'a'.repeat(64);
    const identity = { project: 'Recovery', task: task.id, id: lease.session.id };
    const bound = await server.api('POST', '/api/terminal/recovery/bind', { ...identity, owner: lease.owner, renderer, label: 'first' }, { Cookie: cookie, Origin: server.base });
    const list = await server.api('POST', '/api/terminal/recovery/list', { renderer }, { Cookie: cookie });
    assert.equal(bound.status, 200);
    assert.ok(bound.json && typeof bound.json === 'object' && 'ticket' in bound.json && typeof bound.json.ticket === 'string');
    const ticket = bound.json.ticket;
    assert.equal((await server.api('POST', '/api/terminal/recovery/list', { renderer })).status, 403);
    assert.equal(list.status, 200);
    assert.ok(list.json && typeof list.json === 'object' && 'tabs' in list.json && Array.isArray(list.json.tabs));
    assert.equal(list.json.tabs.length, 1);
    assert.deepEqual((await server.api('POST', '/api/terminal/recovery/list', { renderer }, { Cookie: otherCookie })).json, { generation: server.app.terminal.recoveryGeneration, tabs: [] });
    assert.equal((await server.api('POST', '/api/terminal/recovery/claim', { ...identity, renderer, ticket }, { Cookie: otherCookie })).status, 403);
    assert.equal((await server.api('POST', '/api/terminal/recovery/claim', { ...identity, renderer: 'b'.repeat(64), ticket }, { Cookie: cookie })).status, 403);
    assert.equal((await server.api('POST', '/api/terminal/recovery/list', { renderer }, { Cookie: cookie, Origin: `http://localhost:${server.port}` })).status, 403);
    assert.equal((await server.api('POST', '/api/terminal/recovery/claim', { ...identity, renderer, ticket }, { Cookie: cookie })).status, 200);
    assert.equal((await server.api('POST', '/api/terminal/recovery/claim', { ...identity, renderer, ticket }, { Cookie: cookie })).status, 403);
    await server.app.terminal.stopAll();
    assert.deepEqual(server.app.terminal.listRecovery('a'.repeat(64), renderer), []);
    const priorGeneration = server.app.terminal.recoveryGeneration;
    await server.app.relocate(path.join(server.dir, 'next-workspace'));
    assert.notEqual(server.app.terminal.recoveryGeneration, priorGeneration);
    assert.equal((await server.api('POST', '/api/terminal/recovery/list', { renderer }, { Cookie: cookie })).status, 403);
    assert.notEqual((await server.api('POST', '/api/terminal/recovery/claim', { ...identity, renderer, ticket }, { Cookie: cookie })).status, 200);
  } finally { await server.close(); }
});
