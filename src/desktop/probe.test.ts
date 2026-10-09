import assert from 'node:assert/strict';
import { test } from 'node:test';
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
