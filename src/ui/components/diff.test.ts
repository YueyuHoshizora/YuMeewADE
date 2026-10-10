/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from './diff.ts';

test('multi-file hunks count only content changes and retain no-newline markers', () => {
  const files = parseDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1,2 @@\n+++ content\n+second\n');
  assert.deepEqual(files.map(f => [f.path, f.added, f.removed]), [['a.ts', 1, 1], ['b.ts', 2, 0]]);
  assert.deepEqual(files[0]!.lines.at(-1), { text: '\\ No newline at end of file', kind: 'meta' });
});
test('rename and mode-only sections preserve metadata without invented counts', () => {
  const [file] = parseDiff('diff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\nold mode 100644\nnew mode 100755');
  assert.equal(file!.path, 'new name');
  assert.equal(file!.added + file!.removed, 0);
  assert.equal(file!.lines.length, 6);
  assert.ok(file!.lines.every(l => l.kind === 'meta'));
});
test('binary notices and quoted UTF-8 names remain intact', () => {
  const [file] = parseDiff('diff --git "a/\\346\\226\\207.png" "b/\\346\\226\\207.png"\nnew file mode 100644\nBinary files /dev/null and b/文.png differ');
  assert.equal(file!.path, '文.png');
  assert.equal(file!.added, 0);
  assert.equal(file!.removed, 0);
  assert.equal(file!.lines.at(-1)!.text, 'Binary files /dev/null and b/文.png differ');
});
test('empty diff has no sections', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff('\n  \n'), []);
});
test('plain unified diff uses its file header', () => {
  const [file] = parseDiff('--- a/test\n+++ b/test\n@@ -1 +1 @@\n-a\n+b');
  assert.equal(file!.path, 'test');
  assert.equal(file!.added, 1);
  assert.equal(file!.removed, 1);
});
