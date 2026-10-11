import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Project, Task, VerifyResult } from '../shared/types.ts';
import { startTestServer } from '../testing/server.ts';

test('verify uses the ledger command and logs metadata only', async () => {
  const server = await startTestServer('');
  try {
    const project = (await server.api('POST', '/api/project/new', { name: 'P' })).json as Project;
    const task = (await server.api('POST', '/api/task/new', { project: project.id, title: 'Verify', workspace: 'direct' })).json as Task;
    const ids = { project: project.id, task: task.id };
    assert.equal((await server.api('POST', '/api/task/verify', ids)).status, 400);
    for (const verify of [123, 'a\nb', 'x'.repeat(501)]) {
      assert.equal((await server.api('POST', '/api/project/update', { project: project.id, patch: { verify } })).status, 400);
    }
    const command = `"${process.execPath}" -e "process.stdout.write('ledger-only')"`;
    assert.equal((await server.api('POST', '/api/project/update', { project: project.id, patch: { verify: command } })).status, 200);
    const response = await server.api('POST', '/api/task/verify', { ...ids, command: 'exit 99', verify: 'exit 99' });
    assert.equal(response.status, 200);
    const result = response.json as VerifyResult;
    assert.equal(result.ok, true); assert.equal(result.output, 'ledger-only');
    const entry = (await server.app.oplog.recent()).find(row => row.action === 'verify')!;
    assert.equal(entry.ok, true); assert.equal(entry.exitCode, 0); assert.equal(typeof entry.ms, 'number');
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'at', 'exitCode', 'ms', 'ok', 'project', 'task']);
  } finally { await server.close(); }
});

test('merge HTTP gate rejects missing, failed and stale verification and accepts a current pass', async () => {
  const server = await startTestServer('');
  try {
    const project = (await server.api('POST', '/api/project/new', { name: 'P' })).json as Project;
    const task = (await server.api('POST', '/api/task/new', { project: project.id, title: 'Gate', workspace: 'isolated' })).json as Task;
    const copy = await server.app.worktree.prepare(project.id, task.id);
    await fs.writeFile(path.join(copy, 'gate.txt'), 'verified change');
    const ids = { project: project.id, task: task.id };
    const check = (code: number) => [{ name: 'test', command: `"${process.execPath}" -e "process.exit(${code})"` }];
    assert.equal((await server.api('POST', '/api/project/update', { project: project.id, patch: { requireVerification: true, checks: check(1) } })).status, 200);
    assert.equal((await server.api('POST', '/api/task/merge', ids)).status, 409);
    await server.api('POST', '/api/task/verify', ids);
    assert.equal((await server.api('POST', '/api/task/merge', ids)).status, 409);
    await server.api('POST', '/api/project/update', { project: project.id, patch: { checks: check(0) } });
    await server.api('POST', '/api/task/verify', ids);
    assert.equal((await server.api('POST', '/api/task/merge', ids)).status, 200);
    assert.equal(await fs.readFile(path.join(await server.app.worktree.bodyPath(project.id), 'gate.txt'), 'utf8'), 'verified change');
    await server.api('POST', '/api/task/verify', ids);
    await fs.writeFile(path.join(server.app.projects.bodyPath(await server.app.projects.get(project.id)), 'external.txt'), 'new content');
    assert.equal((await server.api('POST', '/api/task/merge', ids)).status, 409);
  } finally { await server.close(); }
});
