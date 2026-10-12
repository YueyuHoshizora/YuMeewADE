import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedMatches } from './editor-search.ts';

test('regex anchors match every line while literal text stays literal', async () => {
  const text = 'Needle 10 x\nNeedle 11 x\nneedle 12 x\nprefix Needle 13 x';
  const anchored = await boundedMatches(text, '^Needle 1[0-9] ', { regex: true, caseSensitive: true });
  assert.deepEqual(anchored.offsets.map(([start, end]) => text.slice(start, end)), ['Needle 10 ', 'Needle 11 ']);
  const ending = await boundedMatches(text, 'x$', { regex: true, caseSensitive: true });
  assert.equal(ending.offsets.length, 4);
  const literal = await boundedMatches('^Needle and Needle', '^Needle', { caseSensitive: true });
  assert.deepEqual(literal.offsets, [[0, 7]]);
});
