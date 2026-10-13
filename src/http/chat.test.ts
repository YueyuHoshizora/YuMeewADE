import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import type { Task, UploadResult } from '../shared/types.ts';
import { MockCliProvider } from '../cli/mock.ts';
import { startTestServer } from '../testing/server.ts';
test('HTTP roleless send, snapshot first, stop queue and attachment preview', async () => {
  const s = await startTestServer('', { providers: { codex: new MockCliProvider({ chunkMs: 2, text: 'reply' }) } });
  try {
    assert.equal((await s.api('POST', '/api/project/new', { name: 'P' })).status, 200);
    const created = await s.api('POST', '/api/task/new', { project: 'P', title: 'T', workspace: 'direct' }); assert.equal(created.status, 200); const task = created.json as Task;
    const upload = await fetch(`${s.base}/api/upload?project=P&name=test.png`, { method: 'POST', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) }); assert.equal(upload.status, 200); const image = await upload.json() as UploadResult;
    const preview = await fetch(s.base + image.url); assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task: task.id, text: '[slow] go', images: [image.id] })).status, 200);
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task: task.id, text: 'missing mode' })).status, 409);
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task: task.id, text: 'queued', mode: 'queue' })).status, 200);
    assert.equal((await s.api('POST', '/api/chat/stop', { project: 'P', task: task.id })).status, 200); await s.app.runner.whenIdle();
    assert.deepEqual(await s.app.store.readQueue('P', task.id), []); assert.equal(s.app.runner.unread().length, 1);
    const stream = await fetch(`${s.base}/api/chat/stream?project=P&task=${task.id}`); const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let first = '';
    while (!first.includes('event: snapshot')) { const chunk = await reader.read(); assert.equal(chunk.done, false); first += decoder.decode(chunk.value, { stream: true }); }
    assert.equal(first.match(/event: (\w+)/u)?.[1], 'snapshot'); await reader.cancel(); assert.equal(s.app.runner.unread().length, 0);
    const rows = await s.app.store.readLog('P', task.id); const user = rows.find(r => r.role === 'user'); assert.ok(user && user.role === 'user'); assert.equal(path.basename(user.images![0]!), image.id);
    const attached = await fetch(`${s.base}/api/attachment?project=P&task=${task.id}&name=${image.id}`); assert.equal(attached.status, 200); assert.equal(attached.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${s.base}/api/attachment?project=P&task=${task.id}&name=..%2FPROJECT.md`)).status, 400);
  } finally { await s.close(); }
});
test('a chat stream refused at the SSE connection limit leaves the result unread', async () => {
  const s = await startTestServer('limits:\n  sseConnections: 1\n', { providers: { codex: new MockCliProvider({ chunkMs: 1, text: 'reply' }) } });
  const held = new AbortController();
  // Kept referenced until the end: an unreferenced fetch Response is collected and its body cancelled, closing the connection.
  let holding: Response | undefined;
  try {
    await s.api('POST', '/api/project/new', { name: 'P' });
    const task = (await s.api('POST', '/api/task/new', { project: 'P', title: 'T', workspace: 'direct' })).json as Task;
    await s.api('POST', '/api/chat/send', { project: 'P', task: task.id, text: 'hello' }); await s.app.runner.whenIdle();
    holding = await fetch(`${s.base}/api/events`, { signal: held.signal });
    assert.equal((await s.api('GET', `/api/chat/stream?project=P&task=${task.id}`)).status, 503);
    assert.equal(s.app.runner.unread().length, 1);
  } finally { await holding?.body?.cancel().catch(() => {}); held.abort(); await s.close(); }
});
test('quickstart creates current-phase task, saves selection; settings and roles endpoints', async () => {
  const s = await startTestServer();
  try {
    await s.api('POST', '/api/project/new', { name: 'P' });
    const result = await s.api('POST', '/api/start', { project: 'P', text: 'Make this', ai: 'mock', model: 'custom', effort: 'high' }); assert.equal(result.status, 200);
    const task = (result.json as { task: Task }).task; assert.equal(task.phase, '計畫'); assert.equal(task.title, 'Make this'); await s.app.runner.whenIdle();
    // A long first line is cut at 40 code units; an emoji straddling the cut is dropped whole, not saved as U+FFFD.
    const long = await s.api('POST', '/api/start/prepare', { project: 'P', text: `${'a'.repeat(39)}😀 finish`, ai: 'mock' });
    assert.equal((long.json as { task: Task }).task.title, 'a'.repeat(39));
    assert.equal((await s.app.tasks.get('P', (long.json as { task: Task }).task.id)).title, 'a'.repeat(39));
    assert.equal((await s.api('POST', '/api/settings', { fullAccess: { codex: false } })).status, 200);
    assert.equal((await s.api('POST', '/api/roles', { roles: [{ name: '人工', job: 'verify', main: { cli: '人', model: '', effort: '' } }] })).status, 200);
    const ai = await s.api('GET', '/api/ai'); assert.equal(ai.status, 200); assert.ok(Array.isArray(ai.json));
    // Grok and Gemini lists come only from their authenticated CLIs, so a fresh test HOME has none.
    assert.ok((ai.json as { name: string; models: unknown[] }[]).filter(info => info.name === 'claude' || info.name === 'codex').every(info => info.models.length));
  } finally { await s.close(); }
});

test('chat export returns Markdown attachment and rejects unsafe names', async () => {
  const s = await startTestServer();
  try {
    await s.api('POST', '/api/project/new', { name: 'P' });
    const created = await s.api('POST', '/api/task/new', { project: 'P', title: "測試 (一)'", workspace: 'direct' });
    const task = created.json as Task;
    await s.app.store.append('P', task.id, { role: 'event', at: 'now', tool: true, text: `Read ${s.app.ws.root}/secret` });
    await s.app.store.append('P', task.id, { role: 'assistant', at: 'now', ai: 'mock', request: 'r', ms: 1, text: 'reply', usage: { input: 1, output: 2 } });
    const response = await fetch(`${s.base}/api/chat/export?project=P&task=${task.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent(task.title + '.md').replace(/['()*]/gu, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`);
    const text = await response.text();
    assert.match(text, /reply/u); assert.match(text, /輸入 1／輸出 2/u);
    assert.ok(!text.includes('Read'));
    const tools = await fetch(`${s.base}/api/chat/export?project=P&task=${task.id}&tools=1`);
    const toolText = await tools.text();
    assert.ok(toolText.includes('Read'));
    assert.ok(!toolText.includes(s.app.ws.root));
    assert.equal((await fetch(`${s.base}/api/chat/export?project=..&task=${task.id}`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/chat/export?project=P&task=..`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/chat/export?project=P&task=20260101-999`)).status, 404);
  } finally { await s.close(); }
});

test('sending while a terminal runs in the task reports the tool, not a role workflow', async (t) => {
  const s = await startTestServer();
  try {
    await s.api('POST', '/api/project/new', { name: 'P' });
    const task = (await s.api('POST', '/api/task/new', { project: 'P', title: 'T', workspace: 'direct' })).json as Task;
    const running = t.mock.method(s.app.terminal, 'isRunning', (project: string, id?: string) => project === 'P' && id === task.id);
    const blocked = await s.api('POST', '/api/chat/send', { project: 'P', task: task.id, text: 'go', ai: 'mock' });
    assert.equal(blocked.status, 409);
    assert.equal((blocked.json as { detail?: string }).detail, 'task_busy');
    running.mock.restore();
    assert.equal((await s.api('POST', '/api/chat/send', { project: 'P', task: task.id, text: 'go', ai: 'mock' })).status, 200);
    await s.app.runner.whenIdle();
  } finally { await s.close(); }
});
