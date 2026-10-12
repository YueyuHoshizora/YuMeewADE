import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState } from '../../shared/types.ts';

const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true });
// Locale initialization reads browser globals, so import only after installing the fixture.
const { workspaceLocalKey } = await import('./dom.ts');

test('browser-kept drafts of different workspaces never share a key, and older keys are adopted once', () => {
  const at = (root: string) => ({ root }) as AppState;
  // Dots in the workspace root and in the project name must not line up into one key.
  assert.notEqual(workspaceLocalKey(at('/ws'), 'draft', 'foo.bar/1'), workspaceLocalKey(at('/ws.foo'), 'draft', 'bar/1'));
  storage.setItem('yumeewade.draft@/w.P/1', JSON.stringify('dot-joined'));
  storage.setItem('yumeewade.pick.P/1', JSON.stringify('unscoped'));
  const draft = workspaceLocalKey(at('/w'), 'draft', 'P/1'); const pick = workspaceLocalKey(at('/w'), 'pick', 'P/1');
  assert.equal(storage.getItem(draft), JSON.stringify('dot-joined')); assert.equal(storage.getItem(pick), JSON.stringify('unscoped'));
  assert.equal(storage.getItem('yumeewade.draft@/w.P/1'), null); assert.equal(storage.getItem('yumeewade.pick.P/1'), null);
});
