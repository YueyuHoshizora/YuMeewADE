import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { Router } from './router.ts';

async function startRouter(limit: number) {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const router = new Router({ host: '127.0.0.1', port, bodyBytes: limit });
  router.postRaw('/api/upload', limit, async () => ({ accepted: true }));
  router.post('/api/json', async () => ({ accepted: true }));
  router.postStream('/api/stream', limit, async ({ stream }) => {
    for await (const _chunk of stream!) { /* Consume without buffering. */ }
    return { accepted: true };
  });
  server.on('request', (req, res) => void router.handle(req, res));
  return { server, base: `http://127.0.0.1:${port}` };
}

test('declared oversized bodies deliver JSON 413 while the client is still uploading', async () => {
  const limit = 20 * 1024 * 1024;
  const { server, base } = await startRouter(limit);
  try {
    const body = Buffer.alloc(limit + 4 * 1024 * 1024);
    for (const route of ['upload', 'json', 'stream']) {
      const res = await fetch(`${base}/api/${route}`, { method: 'POST', body });
      assert.equal(res.status, 413, route);
      assert.equal(res.headers.get('connection'), 'close');
      assert.deepEqual(await res.json(), { error: 'too_large', message: '內容過大' });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('chunked overflow still delivers JSON 413', async () => {
  const { server, base } = await startRouter(100);
  try {
    const response = await new Promise<{ status: number; connection: string | undefined; body: string }>((resolve, reject) => {
      const req = http.request(`${base}/api/upload`, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, connection: res.headers.connection, body }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(Buffer.alloc(200));
      req.end();
    });
    assert.equal(response.status, 413);
    assert.equal(response.connection, 'close');
    assert.deepEqual(JSON.parse(response.body), { error: 'too_large', message: '內容過大' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
