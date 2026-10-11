/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySlash, slashAt } from './slash.ts';

test('slash completion applies only to the first command token at the caret', () => {
  assert.deepEqual(slashAt('/', 1), { query: '', end: 1 });
  assert.deepEqual(slashAt('/review', 4), { query: 'rev', end: 7 });
  assert.deepEqual(slashAt('/team:review @src/main.ts', 12), { query: 'team:review', end: 12 });
  for (const [text, caret] of [[' /review', 8], ['hello /review', 13], ['/review arg', 8], ['/@src/main.ts', 5], ['/review', 0]] as const) {
    assert.equal(slashAt(text, caret), null);
  }
});

test('choosing a command replaces the entire command name without losing arguments or mentions', () => {
  const draft = '/review @src/main.ts\nKeep this note';
  const token = slashAt(draft, 4)!;
  assert.deepEqual(applySlash(draft, token, 'team:review'), {
    text: '/team:review @src/main.ts\nKeep this note', caret: 13,
  });
  assert.deepEqual(applySlash('/rev', slashAt('/rev', 4)!, 'review'), { text: '/review ', caret: 8 });
  assert.deepEqual(applySlash('/rev\n@src/main.ts', slashAt('/rev\n@src/main.ts', 4)!, 'review'), { text: '/review \n@src/main.ts', caret: 8 });
});
