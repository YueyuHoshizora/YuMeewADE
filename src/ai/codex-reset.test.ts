import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchCodexReset } from './codex-reset.ts';

const reply = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test('Codex 重置排程：取 data.scheduled_reset.scheduled_for，沒有排程或格式錯誤為 null', async () => {
  assert.equal(await fetchCodexReset(reply({ data: { scheduled_reset: { scheduled_for: '2026-10-11T07:00:00.000Z' } } })), '2026-10-11T07:00:00.000Z');
  assert.equal(await fetchCodexReset(reply({ data: { scheduled_reset: null } })), null);
  assert.equal(await fetchCodexReset(reply({ data: { scheduled_reset: { scheduled_for: 'x' } } })), null);
  assert.equal(await fetchCodexReset(reply({}, 500)), null);
  assert.equal(await fetchCodexReset(async () => { throw new Error('net'); }), null);
});
