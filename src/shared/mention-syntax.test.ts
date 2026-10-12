import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MENTION_PATTERN, mentionReference, mentionTarget } from './mention-syntax.ts';

const read = (text: string): string[] => [...text.matchAll(MENTION_PATTERN)].map(mentionTarget);

test('every path the composer writes reads back whole, followed by prose in either language', () => {
  for (const target of ['src/a.ts', 'src/a.ts#L2-3', 'v1.2', 'a..b', 'a(1).ts', 'docs/my notes.md', '會議（草稿）.md', '筆記，第一版.md', 'notes.', 'end)', "it's", 'my "notes".txt', 'say "hi"', 'a"b.txt']) {
    for (const after of [' rest', '，然後', '. Next', '']) assert.deepEqual(read(`看 ${mentionReference(target)}${after}`), [target], `${target} + ${JSON.stringify(after)}`);
  }
  assert.equal(mentionReference('src/a.ts'), '@src/a.ts', 'ordinary paths stay unquoted');
  assert.equal(mentionReference('my "notes".txt'), '@"my \\"notes\\".txt"');
});
