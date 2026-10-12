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

test('Windows paths printed by terminal tools are links mapped under the terminal root', () => {
  const line = 'error at C:\\Work\\Repo\\src\\main.ts:12:3 and src\\util.ts(4,2)';
  assert.deepEqual(terminalLinkAt(line, line.indexOf('main.ts')), { kind: 'file', path: 'C:\\Work\\Repo\\src\\main.ts', line: 12 });
  assert.deepEqual(terminalLinkAt(line, line.indexOf('util.ts')), { kind: 'file', path: 'src\\util.ts', line: 4 });
  assert.equal(terminalFilePath('C:\\Work\\Repo\\src\\main.ts', 'C:\\Work\\Repo'), 'src/main.ts');
  // Case differs between the printed path and the root, as Windows allows.
  assert.equal(terminalFilePath('c:/work/repo/src/main.ts', 'C:\\Work\\Repo\\'), 'src/main.ts');
  assert.equal(terminalFilePath('src\\util.ts', 'C:\\Work\\Repo'), 'src/util.ts');
  assert.equal(terminalFilePath('C:\\Work\\Repository\\a.ts', 'C:\\Work\\Repo'), undefined);
  assert.equal(terminalFilePath('D:\\Work\\Repo\\a.ts', 'C:\\Work\\Repo'), undefined);
  assert.equal(terminalFilePath('src\\..\\..\\a.ts', 'C:\\Work\\Repo'), undefined);
});
