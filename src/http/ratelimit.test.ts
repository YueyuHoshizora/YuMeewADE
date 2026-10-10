import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from './ratelimit.ts';

test('rate limiter prunes expired keys on bounded cadence', () => {
  const limiter = new RateLimiter(2, 100);
  const state = limiter as unknown as { hits: Map<string, number[]> };
  const hits = state.hits;
  assert.equal(limiter.take('old', 0), true);
  assert.equal(limiter.take('old', 1), true);
  assert.equal(limiter.take('old', 2), false);
  assert.equal(limiter.take('new', 99), true);
  assert.equal(hits.size, 2);
  assert.equal(limiter.take('new', 101), true);
  assert.equal(hits.has('old'), false);
  assert.equal(limiter.take('new', 102), false);
  assert.equal(limiter.take('later', 202), true);
  assert.deepEqual([...hits.keys()], ['later']);
  const disabled = new RateLimiter(0, 100);
  assert.equal(disabled.take('empty', 0), false);
  const disabledState = disabled as unknown as { hits: Map<string, number[]> };
  assert.equal(disabledState.hits.size, 0);
});
