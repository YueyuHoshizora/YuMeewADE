import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestServer } from '../testing/server.ts';
import { probe, waitForCore } from './probe.ts';

test('probe：核心在線回 true；關閉後回 false；waitForCore 依 alive 提前放棄', async () => {
  const s = await startTestServer();
  try {
    assert.equal(await probe('127.0.0.1', s.port), true);
    assert.equal(await waitForCore('127.0.0.1', s.port, { timeoutMs: 2000, intervalMs: 10, alive: () => true }), 'ready');
  } finally {
    await s.close();
  }
  assert.equal(await probe('127.0.0.1', s.port), false);
  assert.equal(await waitForCore('127.0.0.1', s.port, { timeoutMs: 2000, intervalMs: 10, alive: () => false }), 'dead');
});

test('a program on the port that keeps streaming cannot hold the probe or the startup wait past their deadlines', async () => {
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200); res.write(' ');
    const timer = setInterval(() => res.write(' '), 10); timers.add(timer);
    res.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    let started = Date.now();
    assert.equal(await probe('127.0.0.1', port, 50), false);
    assert.ok(Date.now() - started < 1000);
    started = Date.now();
    assert.equal(await waitForCore('127.0.0.1', port, { timeoutMs: 100, intervalMs: 10, alive: () => true }), 'timeout');
    assert.ok(Date.now() - started < 1000);
  } finally {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
