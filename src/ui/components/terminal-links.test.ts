import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalFilePath, terminalLinkAt } from './terminal-links.ts';

test('URLs drop trailing punctuation and unbalanced brackets but keep balanced ones', () => {
  const line = 'Local: http://localhost:5173/app. (see https://en.wikipedia.org/wiki/Foo_(bar))';
  assert.deepEqual(terminalLinkAt(line, line.indexOf('localhost')), { kind: 'url', url: 'http://localhost:5173/app' });
  assert.deepEqual(terminalLinkAt(line, line.indexOf('wiki/')), { kind: 'url', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
  // The trimmed full stop is not part of any link.
  assert.equal(terminalLinkAt(line, line.indexOf('app.') + 4), undefined);
});

test('file references carry line numbers from colon and tsc formats', () => {
  const stack = '    at run (/repo/src/chat/runner.ts:412:17)';
  assert.deepEqual(terminalLinkAt(stack, stack.indexOf('runner')), { kind: 'file', path: '/repo/src/chat/runner.ts', line: 412 });
  const tsc = 'src/a.ts(12,5): error TS2322';
  assert.deepEqual(terminalLinkAt(tsc, 0), { kind: 'file', path: 'src/a.ts', line: 12 });
  assert.deepEqual(terminalLinkAt('edit ./README.md now', 7), { kind: 'file', path: './README.md' });
});

test('prose, versions and abbreviations are not links', () => {
  for (const [text, column] of [['node v24.1.0 ready', 7], ['e.g. this', 1], ['3.14159', 2], ['plain words', 3]] as const) assert.equal(terminalLinkAt(text, column), undefined, text);
  assert.deepEqual(terminalLinkAt('see a.c:3', 5), { kind: 'file', path: 'a.c', line: 3 });
});

test('printed paths map inside the root only', () => {
  assert.equal(terminalFilePath('/repo/src/a.ts', '/repo/'), 'src/a.ts');
  assert.equal(terminalFilePath('./src/a.ts', '/repo'), 'src/a.ts');
  assert.equal(terminalFilePath('/repository/a.ts', '/repo'), undefined);
  assert.equal(terminalFilePath('../other/a.ts', '/repo'), undefined);
  assert.equal(terminalFilePath('src/../../a.ts', '/repo'), undefined);
  assert.equal(terminalFilePath('/repo/a.ts', ''), undefined);
});
