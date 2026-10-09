import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSend } from './composer.ts';
const enter = { key: 'Enter', keyCode: 13, isComposing: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
test('sending preserves default shortcut and supports Enter with Shift newline', () => {
  assert.equal(shouldSend(enter, false), false);
  assert.equal(shouldSend({ ...enter, ctrlKey: true }, false), true);
  assert.equal(shouldSend({ ...enter, metaKey: true }, false), true);
  assert.equal(shouldSend(enter, true), true);
  assert.equal(shouldSend({ ...enter, shiftKey: true }, true), false);
});
test('IME confirmation never sends in either mode', () => {
  for (const mode of [false, true]) {
    assert.equal(shouldSend({ ...enter, ctrlKey: true, isComposing: true }, mode), false);
    assert.equal(shouldSend({ ...enter, metaKey: true, keyCode: 229 }, mode), false);
  }
});
