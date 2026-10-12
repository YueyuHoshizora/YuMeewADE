import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankFiles } from './file-match.ts';

const files = ['src/ui/components/files.ts', 'src/system/editor-search.ts', 'docs/FILES.md', 'src/ui/components/file-preview.ts', 'src/fixtures/a/b/t/s.txt', 'README.md'];

test('quick open ranks basename prefix, basename, path, basename subsequence, then cross-directory subsequence', () => {
  assert.deepEqual(rankFiles(files, 'file'), ['docs/FILES.md', 'src/ui/components/files.ts', 'src/ui/components/file-preview.ts']);
  assert.deepEqual(rankFiles(files, 'search'), ['src/system/editor-search.ts']);
  assert.deepEqual(rankFiles(files, 'components/'), ['src/ui/components/files.ts', 'src/ui/components/file-preview.ts']);
  // Subsequence: "f…t…s" fits inside files.ts / file-preview.ts; the fixture path only matches across directories.
  assert.deepEqual(rankFiles(files, 'fts'), ['src/ui/components/files.ts', 'src/ui/components/file-preview.ts', 'src/fixtures/a/b/t/s.txt']);
  assert.deepEqual(rankFiles(files, 'zzz'), []);
});

test('empty query keeps every file, shortest paths first', () => {
  assert.deepEqual(rankFiles(['b/long-name.ts', 'a.ts', 'c.ts'], ''), ['a.ts', 'c.ts', 'b/long-name.ts']);
});
