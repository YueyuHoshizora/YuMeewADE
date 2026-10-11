import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionMention } from './editor-mention.ts';

test('empty primary selection mentions only the relative file path', () => {
  assert.equal(selectionMention('src/main.ts', 3, 3, true), '@src/main.ts ');
});
test('single-line selection uses one 1-based line suffix', () => {
  assert.equal(selectionMention('src/main.ts', 1, 1, false), '@src/main.ts#L1 ');
});
test('multi-line selection includes both line boundaries and preserves Unicode paths', () => {
  assert.equal(selectionMention('資料/範例.ts', 2, 9, false), '@資料/範例.ts#L2-9 ');
});
