/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionReviewDrafts, reviewKey } from './review-drafts.ts';

test('saved review anchors restore only on the identical diff revision', () => {
  const saved = { path: 'src/a.ts', oldLine: 10, newLine: 20, hash: 'a'.repeat(64), code: 'value', comment: 'change this' };
  const reloaded = JSON.parse(JSON.stringify([saved])) as typeof saved[];
  const same = partitionReviewDrafts(reloaded, saved.hash);
  assert.equal(same.stale.length, 0);
  assert.deepEqual(same.current.get(reviewKey('src/a.ts', { oldLine: 10, newLine: 20 })), saved);
  assert.equal(same.current.has(reviewKey('src/b.ts', { oldLine: 10, newLine: 20 })), false);
  assert.equal(same.current.has(reviewKey('src/a.ts', { oldLine: 11, newLine: 20 })), false);
  const changed = partitionReviewDrafts(reloaded, 'b'.repeat(64));
  assert.equal(changed.current.size, 0);
  assert.deepEqual(changed.stale, [saved]);
});
