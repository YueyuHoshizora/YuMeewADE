import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { EmbeddedPreviewService } from './embedded-preview.ts';
import { AppError } from '../shared/errors.ts';

const serverCode = `
const http = require('node:http');
const crypto = require('node:crypto');
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { location: 'http://example.com/' }); res.end(); return; }
  if (req.url === '/') { res.writeHead(302, { location: '/home?next=%2F' }); res.end(); return; }
  if (req.url === '/self') { res.writeHead(301, { location: 'http://localhost:' + process.env.PORT + '/home#top' }); res.end(); return; }
  if (req.url === '/other-port') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
  if (req.url === '/scheme-relative') { res.writeHead(302, { location: 'http://127.0.0.1:' + process.env.PORT + '//evil.example/x' }); res.end(); return; }
  if (req.url === '/api/data') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null, ok: true })); return; }
  res.setHeader('Content-Type', 'text/html'); res.setHeader('Set-Cookie', 'danger=1');
  res.end('<!doctype html><script>document.body.dataset.live="true";fetch("/api/data").then(r=>r.json()).then(v=>document.body.dataset.api=v.ok)</script><body>Owned preview</body>');
});
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  socket.write(Buffer.from([0x81, 2, 111, 107]));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
`;

function requestStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = request(url, { headers }, response => {
    response.resume();
    response.once('end', () => resolve(response.statusCode ?? 0));
    response.once('error', reject);
  });
  req.once('error', reject);
  req.end();
  return promise;
}

test('owned preview lifecycle isolates headers, redirects and exact nested navigation origins', async () => {
  let trusted = true;
  const service = new EmbeddedPreviewService({ cwd: async () => process.cwd(), assertTrusted: async () => { if (!trusted) throw new AppError('forbidden'); }, ideOrigin: 'http://127.0.0.1:3000' });
  await service.init();
  const gateway = service.gatewayOrigin();
  try {
    const view = await service.start('project', 'task', { command: process.execPath, args: ['-e', serverCode, '--', '{port}'] });
    // Real TCP completion drives readiness; no elapsed-time polling or test-only service hooks.
    while (service.status('project', 'task', view.id).state === 'starting') {
      try { await requestStatus(view.targetUrl); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ECONNREFUSED') throw error; }
    }
    assert.equal(service.status('project', 'task', view.id).state, 'running');
    assert.equal(new URL(view.url).origin, gateway);
    const wrapper = await fetch(view.url);
    const origin = service.origins().find(value => value !== gateway);
    assert.ok(origin);
    assert.match(wrapper.headers.get('content-security-policy') ?? '', new RegExp(`frame-src ${origin.replaceAll('.', '\\.')};`));
    assert.match(await wrapper.text(), /sandbox="allow-scripts"/);
    const response = await fetch(origin + '/home', { headers: { Origin: 'null' } });
    assert.match(await response.text(), /Owned preview/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), 'null');
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox allow-scripts/);
    const data = await fetch(origin + '/api/data', { headers: { Origin: 'null', Cookie: 'ide=secret', Authorization: 'Bearer secret' } });
    assert.deepEqual(await data.json(), { cookie: null, authorization: null, ok: true });
    assert.equal((await fetch(origin + '/redirect', { redirect: 'manual' })).status, 502);
    // A root that redirects within the dev server (login, base path, trailing slash) keeps working as a path on the proxy.
    const root = await fetch(origin + '/', { redirect: 'manual' });
    assert.deepEqual([root.status, root.headers.get('location')], [302, '/home?next=%2F']);
    const self = await fetch(origin + '/self', { redirect: 'manual' });
    assert.deepEqual([self.status, self.headers.get('location')], [301, '/home#top']);
    for (const escape of ['/other-port', '/scheme-relative']) assert.equal((await fetch(origin + escape, { redirect: 'manual' })).status, 502);
    assert.equal((await fetch(origin, { headers: { Origin: 'https://example.com' } })).status, 403);
    // Fetch may replace Host with the URL authority; node:http sends the actual adversarial header.
    assert.equal(await requestStatus(origin, { Host: 'evil.example' }), 403);
    assert.equal((await fetch(gateway + '/unknown')).status, 404);
    assert.equal((await fetch(view.url, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal(await requestStatus(view.url, { Host: 'evil.example' }), 403);
    assert.equal((await fetch(view.url, { method: 'POST' })).status, 403);
    const preflight = await fetch(origin + '/api/data', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
    assert.throws(() => service.status('another-project', 'task', view.id));
    const socket = new WebSocket(origin.replace('http:', 'ws:'));
    const message = Promise.withResolvers<string>();
    socket.onmessage = event => message.resolve(String(event.data)); socket.onerror = () => message.reject(new Error('WebSocket upgrade failed'));
    assert.equal(await message.promise, 'ok'); socket.close();
    await service.reload('project', 'task', view.id);
    trusted = false;
    assert.equal((await fetch(view.url)).status, 403);
    await assert.rejects(service.reload('project', 'task', view.id));
    await service.stop('project', 'task', view.id);
    assert.equal(service.status('project', 'task', view.id).state, 'stopped');
    assert.equal((await fetch(view.url)).status, 404);
    assert.deepEqual(service.origins(), [gateway]);
  } finally { await service.dispose(); }
});

test('preview cannot attach to supplied remote URLs or preexisting ports and requires explicit trust', async () => {
  const service = new EmbeddedPreviewService({ cwd: async () => process.cwd(), assertTrusted: async () => { throw new AppError('forbidden'); }, ideOrigin: 'http://127.0.0.1:3000' });
  try {
    await assert.rejects(service.start('project', 'task', { command: process.execPath, args: ['-e', serverCode, '--', '3000'] }));
    await assert.rejects(service.start('project', 'task', { command: process.execPath, args: ['-e', serverCode, '--', '{port}'] }));
    assert.deepEqual(service.list('project', 'task'), []);
  } finally { await service.dispose(); }
});

test('pending starts block global destructive work without counting an idle gateway', async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const service = new EmbeddedPreviewService({ cwd: async () => process.cwd(), assertTrusted: async () => undefined, beforeStart: async () => { entered.resolve(); await gate.promise; throw new AppError('conflict'); }, ideOrigin: 'http://127.0.0.1:3000' });
  await service.init();
  assert.equal(service.isBusy(), false);
  const start = service.start('project', 'task', { command: process.execPath, args: ['-e', serverCode, '--', '{port}'] });
  const rejected = assert.rejects(start);
  await entered.promise;
  assert.equal(service.isBusy(), true);
  gate.resolve();
  await rejected;
  assert.equal(service.isBusy(), false);
  assert.equal(service.isRunning('project', 'task'), false);
  await service.dispose();
});

test('finished preview runs are bounded while live runs are never evicted', async () => {
  const service = new EmbeddedPreviewService({ cwd: async () => process.cwd(), assertTrusted: async () => undefined, ideOrigin: 'http://127.0.0.1:3000' });
  await service.init();
  try {
    const live = await service.start('project', 'task', { command: process.execPath, args: ['-e', serverCode, '--', '{port}'] });
    const finished: string[] = [];
    for (let index = 0; index < 22; index++) {
      const view = await service.start('project', 'task', { command: process.execPath, args: ['-e', 'process.exit(3)', '--', '{port}'] });
      // The child exits by itself; wait for the real exit to be recorded before the next start can prune it.
      const deadline = Date.now() + 10000;
      while (service.status('project', 'task', view.id).exitCode === null && Date.now() < deadline) {
        const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 10); await tick.promise;
      }
      assert.equal(service.status('project', 'task', view.id).exitCode, 3);
      finished.push(view.id);
    }
    const ids = service.list('project', 'task').map(view => view.id);
    assert.ok(ids.includes(live.id), 'a live preview must stay listed');
    assert.deepEqual(ids.filter(id => id !== live.id), finished.slice(-20));
  } finally { await service.dispose(); }
});
