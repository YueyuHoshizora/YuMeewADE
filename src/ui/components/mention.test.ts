/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMention, mentionAt } from './mention.ts';

test('mentionAt only fires for an @token right before the caret', () => {
  assert.deepEqual(mentionAt('看 @src/a', 8), { start: 2, query: 'src/a' });
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionAt('line1\n@x', 8), { start: 6, query: 'x' });
  assert.equal(mentionAt('mail me at a@b.c', 16), null, 'an @ inside a word is not a mention');
  assert.equal(mentionAt('@src/a done', 11), null, 'a space ends the token');
  assert.equal(mentionAt('@a', 0), null, 'caret before the @');
  assert.deepEqual(mentionAt('x @a rest', 4), { start: 2, query: 'a' }, 'text after the caret is ignored');
});

test('applyMention replaces just the token and moves the caret past the inserted path', () => {
  const text = '請看 @src/ rest';
  const mention = mentionAt(text, 8)!;
  assert.deepEqual(applyMention(text, mention, 8, 'src/app.ts'), { text: '請看 @src/app.ts  rest', caret: 15 });
});
