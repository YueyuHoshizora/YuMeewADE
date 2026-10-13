/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import type { EditorContent as Content } from './editor-engine.ts';

test('applyEdits lands once in every pane showing the file, with its own undo step', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { return null; }, setItem() {} } });
  const { EditorContent } = await import('./editor-engine.ts');
  // Two panes on the same file; typing in one mirrors its whole text into the other, as the workbench does.
  const panes = [0, 1].map(() => {
    const content = Object.create(EditorContent.prototype) as Content;
    const view = {
      state: EditorState.create({ doc: 'abc', extensions: [history()] }),
      dispatch(spec: TransactionSpec) {
        const transaction = this.state.update(spec); this.state = transaction.state;
        if (transaction.docChanged && !Reflect.get(content, 'replacing')) content.oninput?.();
      },
    };
    Object.assign(content, { replacing: false, view });
    return content;
  });
  panes.forEach((pane, index) => { pane.oninput = () => { panes[1 - index]!.value = pane.value; }; });
  for (const pane of panes) pane.applyEdits([{ from: 0, to: 1, text: 'AAA' }]);
  assert.deepEqual(panes.map(pane => pane.value), ['AAAbc', 'AAAbc']);
  for (const pane of panes) pane.applyEdits([{ from: 3, to: 4, text: 'BBB' }]);
  assert.deepEqual(panes.map(pane => pane.value), ['AAABBBc', 'AAABBBc']);
  for (const pane of panes) {
    pane.oninput = () => {};
    const target = { get state() { return pane.view.state; }, dispatch: (spec: TransactionSpec) => pane.view.dispatch(spec) };
    assert.equal(undo(target), true); assert.equal(pane.value, 'AAAbc');
    assert.equal(undo(target), true); assert.equal(pane.value, 'abc');
  }
});
