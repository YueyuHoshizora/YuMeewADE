import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbeddedPreviewService } from './embedded-preview.ts';
import { AppError } from '../shared/errors.ts';

const serverCode = `
const http = require('node:http');
const crypto = require('node:crypto');
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { location: 'http://example.com/' }); res.end(); return; }
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

test('owned preview lifecycle isolates headers, redirects and exact nested navigation origins', async () => {
  let trusted = true;
  const service = new EmbeddedPreviewService({ cwd: async () => process.cwd(), assertTrusted: async () => { if (!trusted) throw new AppError('forbidden'); }, ideOrigin: 'http://127.0.0.1:3000' });
  await service.init();
  const gateway = service.gatewayOrigin();
  try {
    const view = await service.start('project', 'task', { command: process.execPath, args: ['-e', serverCode, '--', '{port}'] });
    // This integration exercises a real child binding a real TCP port; fake time cannot drive that event.
    const deadline = Date.now() + 10000;
    while (service.status('project', 'task', view.id).state === 'starting' && Date.now() < deadline) {
      const delay = Promise.withResolvers<void>(); setTimeout(delay.resolve, 50); await delay.promise;
    }
    assert.equal(service.status('project', 'task', view.id).state, 'running');
    assert.equal(new URL(view.url).origin, gateway);
    const wrapper = await fetch(view.url);
    const origin = service.origins().find(value => value !== gateway);
    assert.ok(origin);
    assert.match(wrapper.headers.get('content-security-policy') ?? '', new RegExp(`frame-src ${origin.replaceAll('.', '\\.')};`));
    assert.match(await wrapper.text(), /sandbox="allow-scripts"/);
    const response = await fetch(origin, { headers: { Origin: 'null' } });
    assert.match(await response.text(), /Owned preview/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), 'null');
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox allow-scripts/);
    const data = await fetch(origin + '/api/data', { headers: { Origin: 'null', Cookie: 'ide=secret', Authorization: 'Bearer secret' } });
    assert.deepEqual(await data.json(), { cookie: null, authorization: null, ok: true });
    assert.equal((await fetch(origin + '/redirect', { redirect: 'manual' })).status, 502);
    assert.equal((await fetch(origin, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(origin, { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await fetch(gateway + '/unknown')).status, 404);
    assert.equal((await fetch(view.url, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(view.url, { headers: { Host: 'evil.example' } })).status, 403);
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
