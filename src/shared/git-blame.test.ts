import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBlame } from './git-blame.ts';

const sha = 'a'.repeat(40);
const zero = '0'.repeat(40);

test('blame porcelain keeps content verbatim, line numbers and uncommitted lines', () => {
  const porcelain = [
    `${sha} 1 1 2`, 'author Ada', 'author-mail <ada@example.com>', 'author-time 1700000000', 'author-tz +0000', 'summary first commit', 'filename a.ts', '\tconst x = 1;',
    // Content that itself looks like a header or key must stay text.
    `${sha} 2 2`, 'author Ada', 'author-time 1700000000', 'summary first commit', 'filename a.ts', `\t${sha} 9 9`,
    `${zero} 3 3 1`, 'author Not Committed Yet', 'author-time 1700000100', 'summary Version of a.ts from a.ts', 'filename a.ts', '\t\tindented author x',
    '',
  ].join('\n');
  assert.deepEqual(parseBlame(porcelain), [
    { line: 1, sha, committed: true, author: 'Ada', time: '2023-11-14T22:13:20.000Z', summary: 'first commit', text: 'const x = 1;' },
    { line: 2, sha, committed: true, author: 'Ada', time: '2023-11-14T22:13:20.000Z', summary: 'first commit', text: `${sha} 9 9` },
    { line: 3, sha: zero, committed: false, author: 'Not Committed Yet', time: '2023-11-14T22:15:00.000Z', summary: 'Version of a.ts from a.ts', text: '\tindented author x' },
  ]);
});
