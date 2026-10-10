import assert from 'node:assert/strict';
import test from 'node:test';
let stored: string | null = 'light';
const root = { dataset: {} as Record<string, string> };
Object.defineProperty(globalThis, 'document', { value: { documentElement: root }, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } }, configurable: true });
// Initial theme application intentionally reads browser storage during module loading.
const { getTheme, setTheme } = await import('./theme.ts');
test('saved theme applies at entry and manual choices persist', () => {
  assert.equal(root.dataset['theme'], 'light');
  setTheme('dark');
  assert.equal(stored, 'dark');
  assert.equal(root.dataset['theme'], 'dark');
  assert.equal(getTheme(), 'dark');
  setTheme('system');
  assert.equal(root.dataset['theme'], 'system');
});
test('invalid and inaccessible storage fall back to system', () => {
  stored = 'unexpected';
  assert.equal(getTheme(), 'system');
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } }, configurable: true });
  assert.equal(getTheme(), 'system');
  setTheme('light');
  assert.equal(root.dataset['theme'], 'light');
});
