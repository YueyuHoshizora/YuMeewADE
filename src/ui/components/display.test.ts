import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true });
// Locale initialization reads browser globals, so import only after installing the fixture.
const { formatBytes } = await import('./display.ts');

test('sizes switch unit at 1024 and stay at terabytes for huge values', () => {
  assert.equal(formatBytes(0, 'en'), '0 byte');
  assert.equal(formatBytes(1023, 'en'), '1,023 byte');
  assert.equal(formatBytes(1024, 'en'), '1 kB');
  assert.equal(formatBytes(38_693, 'en'), '37.8 kB');
  assert.equal(formatBytes(672_467_640_320, 'en'), '626.3 GB');
  assert.equal(formatBytes(5 * 1024 ** 5, 'en'), '5,120 TB');
  assert.equal(formatBytes(38_693, 'de'), '37,8 kB');
});
