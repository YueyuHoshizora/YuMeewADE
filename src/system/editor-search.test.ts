import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMatcher } from './editor-search.ts';

test('regex anchors match every line while literal text stays literal', async () => {
  const text = 'Needle 10 x\nNeedle 11 x\nneedle 12 x\nprefix Needle 13 x';
  const anchored = createMatcher('^Needle 1[0-9] ', { regex: true, caseSensitive: true });
  try { assert.deepEqual((await anchored.match(text)).offsets.map(([start, end]) => text.slice(start, end)), ['Needle 10 ', 'Needle 11 ']); }
  finally { anchored.close(); }
  const ending = createMatcher('x$', { regex: true, caseSensitive: true });
  try { assert.equal((await ending.match(text)).offsets.length, 4); }
  finally { ending.close(); }
  assert.deepEqual((await createMatcher('^Needle', { caseSensitive: true }).match('^Needle and Needle')).offsets, [[0, 7]]);
});

test('one regex matcher serves many texts and still stops a catastrophic pattern', async () => {
  const matcher = createMatcher('line\\s+two', { regex: true });
  try {
    // A match state left over from the previous text must not skip the start of the next one.
    for (const text of ['line two', 'x\nline  two', 'nothing', 'LINE TWO']) assert.equal((await matcher.match(text)).offsets.length, text === 'nothing' ? 0 : 1);
  } finally { matcher.close(); }
  const slow = createMatcher('^(a+)+$', { regex: true, caseSensitive: true });
  try {
    await assert.rejects(slow.match('a'.repeat(40) + 'b'), { code: 'too_large', detail: 'search_regex_slow' });
    await assert.rejects(slow.match('aaa'), { code: 'too_large' }, 'a stopped matcher stays stopped');
  } finally { slow.close(); }
  assert.throws(() => createMatcher('(', { regex: true }), { code: 'bad_request', detail: 'search_regex_invalid' });
});
