import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestServer } from '../../testing/server.ts';
import type { Task, EditorDocument } from '../../shared/types.ts';

test('editor actions reject array coercion rather than accepting a malformed language request', async () => {
  const server = await startTestServer('');
  try {
    await server.api('POST', '/api/project/new', { name: 'Editor' });
    const task = (await server.api('POST', '/api/task/new', { project: 'Editor', title: 'Validation', workspace: 'direct' })).json as Task;
    const ids = { project: 'Editor', task: task.id };
    assert.equal((await server.api('POST', '/api/editor/mutate', { ...ids, action: 'createFile', path: 'source.ts' })).status, 200);
    const document = (await server.api('GET', `/api/editor/file?project=Editor&task=${task.id}&path=source.ts`)).json as EditorDocument;
    assert.equal((await server.api('POST', '/api/editor/language', { ...ids, action: ['definition'], path: 'source.ts', text: '', line: 0, character: 0 })).status, 400);
    assert.equal((await server.api('POST', '/api/editor/mutate', { ...ids, action: ['delete'], path: 'source.ts', revision: document.revision, confirmation: 'source.ts' })).status, 400);
    assert.equal((await server.api('GET', `/api/editor/file?project=Editor&task=${task.id}&path=source.ts`)).status, 200);
  } finally { await server.close(); }
});
