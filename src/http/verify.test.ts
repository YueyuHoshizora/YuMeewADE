import assert from 'node:assert/strict';
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
