import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreState, WindowStateStore } from './window-state.ts';
const display = { x: 0, y: 0, width: 1920, height: 1080 };
test('valid bounds restore, missing/offscreen/invalid bounds center', () => {
  const state = { bounds: { x: 40, y: 50, width: 800, height: 600 }, maximized: true, fullscreen: true };
  assert.deepEqual(restoreState(state, [display]), state);
  for (const value of [null, { bounds: { ...state.bounds, x: 99999 } }, { bounds: { ...state.bounds, width: -1 } }, { bounds: { ...state.bounds, x: NaN } }]) {
    const restored = restoreState(value, [display]);
    assert.ok(restored.bounds.x >= 0 && restored.bounds.x + restored.bounds.width <= display.width);
  }
  assert.deepEqual(restoreState({ ...state, bounds: { ...state.bounds, x: -1800 } }, [{ ...display, x: -1920 }]).bounds.x, -1800);
  // A window across two side-by-side monitors is fully visible and keeps its place; one hanging past both is recentered.
  const pair = [display, { ...display, x: 1920 }];
  assert.deepEqual(restoreState({ ...state, bounds: { ...state.bounds, x: 1500 } }, pair).bounds, { ...state.bounds, x: 1500 });
  assert.notEqual(restoreState({ ...state, bounds: { ...state.bounds, x: 1500, y: 600 } }, pair).bounds.y, 600);
});
test('state is atomically persisted independently per slot', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-state-'));
  try {
    const file = path.join(dir, 'windows.json'); const store = new WindowStateStore(file);
    const one = restoreState(null, [display]); const two = { ...one, maximized: true };
    store.save(0, one); store.save(1, two);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 2);
    assert.deepEqual(new WindowStateStore(file).get(1, [display]), two);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
