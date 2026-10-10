/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { addSnippet, insertSnippet, removeSnippet, sanitizeSnippets, SNIPPET_LIMIT } from './snippets.ts';

test('addSnippet trims, replaces a same-named snippet, ignores blanks and keeps the newest ones', () => {
  let list = addSnippet([], '  跑測試 ', '  npm test  ');
  assert.deepEqual(list, [{ name: '跑測試', text: 'npm test' }]);
  list = addSnippet(list, '跑測試', 'npm run check');
  assert.deepEqual(list, [{ name: '跑測試', text: 'npm run check' }]);
  assert.equal(addSnippet(list, '  ', 'x'), list);
  assert.equal(addSnippet(list, 'x', '  \n '), list);
  for (let i = 0; i < SNIPPET_LIMIT + 5; i++) list = addSnippet(list, `n${i}`, 'body');
  assert.equal(list.length, SNIPPET_LIMIT);
  assert.equal(list.at(-1)!.name, `n${SNIPPET_LIMIT + 4}`);
  assert.equal(list.some(s => s.name === '跑測試'), false, 'the oldest fall off first');
});

test('removeSnippet and insertSnippet', () => {
  assert.deepEqual(removeSnippet([{ name: 'a', text: '1' }, { name: 'b', text: '2' }], 'a'), [{ name: 'b', text: '2' }]);
  assert.equal(insertSnippet('', 'plan it'), 'plan it');
  assert.equal(insertSnippet('  \n', 'plan it'), 'plan it');
  assert.equal(insertSnippet('fix the login bug  \n', 'plan it'), 'fix the login bug\n\nplan it');
});

test('sanitizeSnippets drops anything that is not a well-formed snippet', () => {
  assert.deepEqual(sanitizeSnippets('nope'), []);
  assert.deepEqual(sanitizeSnippets(null), []);
  assert.deepEqual(sanitizeSnippets([{ name: 'a', text: 'b' }, { name: 1, text: 'b' }, { name: 'c' }, null, 'x', { name: 'd', text: 'e', extra: true }]), [{ name: 'a', text: 'b' }, { name: 'd', text: 'e' }]);
  assert.equal(sanitizeSnippets(Array.from({ length: 50 }, (_, i) => ({ name: `n${i}`, text: 't' }))).length, SNIPPET_LIMIT);
});
