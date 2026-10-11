import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestServer } from '../../testing/server.ts';
import type { Task, EditorDocument } from '../../shared/types.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

test('image route confines files, caps size and serves all supported image MIME types safely', async () => {
  const server = await startTestServer('');
  try {
    await server.api('POST', '/api/project/new', { name: 'Images' });
    const root = await server.app.worktree.bodyPath('Images');
    const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
    for (const [extension, mime] of Object.entries(types)) {
      const bytes = extension === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' : 'image fixture';
      await fs.writeFile(path.join(root, `test.${extension}`), bytes);
      const response = await fetch(`${server.base}/api/editor/image?project=Images&path=test.${extension}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; script-src 'none'; sandbox");
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), bytes);
    }
    await fs.writeFile(path.join(root, '.env.png'), 'secret');
    await fs.writeFile(path.join(root, 'plain.txt'), 'text');
    const huge = await fs.open(path.join(root, 'huge.png'), 'w');
    try { await huge.truncate(20 * 1024 * 1024 + 1); } finally { await huge.close(); }
    await fs.symlink(path.join(root, 'test.png'), path.join(root, 'link.png'));
    for (const file of ['../test.png', '/test.png', '.env.png', 'link.png', '.git/config']) {
      assert.equal((await server.api('GET', `/api/editor/image?project=Images&path=${encodeURIComponent(file)}`)).status, 404, file);
    }
    assert.equal((await server.api('GET', '/api/editor/image?project=Images&path=plain.txt')).status, 400);
    assert.equal((await server.api('GET', '/api/editor/image?project=Images&path=huge.png')).status, 413);
    const boundary = await fs.open(path.join(root, 'huge.png'), 'w');
    try { await boundary.truncate(20 * 1024 * 1024); } finally { await boundary.close(); }
    const response = await fetch(`${server.base}/api/editor/image?project=Images&path=huge.png`);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 20 * 1024 * 1024);
  } finally { await server.close(); }
});
