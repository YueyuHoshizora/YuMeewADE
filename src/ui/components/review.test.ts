/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt } from './review.ts';
import { parseDiff } from './diff.ts';

test('review prompt lists each comment with its location and quoted code', () => {
  const prompt = buildReviewPrompt('請修改：', [
    { where: 'a.ts:3', code: 'const x = `y`;', comment: '  改名\n並補測試  ' },
    { where: 'b.ts:1', code: 'z'.repeat(130), comment: '太長' },
  ]);
  assert.equal(prompt, `請修改：\n\n- a.ts:3\n  \`const x = 'y';\`\n  改名\n  並補測試\n\n- b.ts:1\n  \`${'z'.repeat(120)}…\`\n  太長`);
});

test('diff lines carry the line numbers reviews point at', () => {
  const [file] = parseDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +20,4 @@\n keep\n-gone\n+new1\n+new2\n tail\n@@ -40 +50 @@\n-old\n+new\n');
  const numbers = file!.lines.filter(l => l.kind !== 'meta' && l.kind !== 'hunk').map(l => [l.kind, l.oldLine, l.newLine]);
  assert.deepEqual(numbers, [
    ['context', 10, 20], ['removed', 11, undefined], ['added', undefined, 21], ['added', undefined, 22], ['context', 12, 23],
    ['removed', 40, undefined], ['added', undefined, 50],
  ]);
  assert.equal(file!.lines.find(l => l.kind === 'hunk')!.newLine, undefined);
});
