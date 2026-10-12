import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestServer } from '../../testing/server.ts';
import type { MemoryFile } from '../../shared/types.ts';

test('memory endpoints round-trip, reject stale writes and require delete confirmation', async () => {
  const server = await startTestServer();
  try {
    assert.equal((await server.api('POST', '/api/project/new', { name: 'P' })).status, 200);
    const list = await server.api('GET', '/api/project/memory?project=P');
    assert.ok(list.json && typeof list.json === 'object' && 'files' in list.json && Array.isArray(list.json.files) && list.json.files.includes('INDEX.md'));
    const created = await server.api('POST', '/api/project/memory', { project: 'P', name: 'note.md', text: '', revision: null });
    assert.equal(created.status, 200); const note = created.json as MemoryFile;
    assert.deepEqual((await server.api('GET', '/api/project/memory?project=P&name=note.md')).json, note);
    assert.equal((await server.api('POST', '/api/project/memory', { project: 'P', name: 'note.md', text: 'overwrite', revision: null })).status, 409);
    assert.equal((await server.api('POST', '/api/project/memory', { project: 'P', name: 'note.md', text: 123, revision: note.revision })).status, 400);
    // Over the byte cap is reported as too long, whether in characters or only in UTF-8 bytes.
    for (const text of ['x'.repeat(256 * 1024 + 1), 'é'.repeat(140_000)]) {
      const tooLong = await server.api('POST', '/api/project/memory', { project: 'P', name: 'note.md', text, revision: note.revision });
      assert.equal(tooLong.status, 400); assert.equal((tooLong.json as { detail?: string }).detail, 'field_too_long');
    }
    assert.equal((await server.api('POST', '/api/project/memory/delete', { project: 'P', name: 'note.md', revision: note.revision })).status, 400);
    assert.equal((await server.api('POST', '/api/project/memory/delete', { project: 'P', name: 'note.md', revision: note.revision, confirm: true })).status, 200);
    assert.equal((await server.api('GET', '/api/project/memory?project=P&name=note.md')).status, 404);
  } finally { await server.close(); }
});
