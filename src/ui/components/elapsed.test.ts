import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatElapsed } from './elapsed.ts';

test('formatElapsed switches units at minute and hour boundaries and never goes negative', () => {
  assert.equal(formatElapsed(-5000), '0s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(60_000), '1m 00s');
  assert.equal(formatElapsed(185_000), '3m 05s');
  assert.equal(formatElapsed(3_599_000), '59m 59s');
  assert.equal(formatElapsed(3_600_000), '1h 00m');
  assert.equal(formatElapsed(3_600_000 * 2 + 62 * 1000), '2h 01m');
});
