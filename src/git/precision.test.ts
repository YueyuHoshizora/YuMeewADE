import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../shared/errors.ts';
import { parseHunks, selectedPatch } from './precision.ts';

const patch = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';

test('selected lines must be distinct changed lines from the server diff', () => {
  const [context, removed, added] = parseHunks(patch)[0]!.lines.map(line => line.id);
  for (const selection of [[], [context!], [added!, added!], [99], [1.5]]) assert.throws(() => selectedPatch(patch, selection), (err: unknown) => err instanceof AppError && err.detail === 'git_workbench_path');
  // An unselected removal stays as context, so only the addition is applied.
  assert.match(selectedPatch(patch, [added!]), /\n keep\n old\n\+new\n$/);
  assert.match(selectedPatch(patch, [removed!, added!]), /\n-old\n\+new\n$/);
});
