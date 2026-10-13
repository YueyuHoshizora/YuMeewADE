import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { completionChanges } from './editor-completion.ts';

test('completion applies imports and the primary replacement atomically at original offsets', () => {
  const original = '// 😀\n  read()';
  let state = EditorState.create({ doc: original, extensions: [history()] });
  const changes = completionChanges({ label: 'readFile', insertText: 'readFile', start: 8, end: 12, additionalTextEdits: [
    { start: 0, end: 0, insertText: 'import { readFile } from "node:fs";\n' },
    { start: 14, end: 14, insertText: ';' }
  ] }, 8, 12);
  state = state.update({ changes }).state;
  assert.equal(state.doc.toString(), 'import { readFile } from "node:fs";\n// 😀\n  readFile();');
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), original, 'one undo removes the entire completion, including its import');
});

test('completion uses caller selection only when the server omits primary offsets', () => {
  assert.deepEqual(completionChanges({ label: 'name', insertText: 'name' }, 2, 5), [{ from: 2, to: 5, insert: 'name' }]);
});
