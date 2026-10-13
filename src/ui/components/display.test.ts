import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true });
// Locale initialization reads browser globals, so import only after installing the fixture.
const { formatBytes, localTime, localDateTime, workspacePath } = await import('./display.ts');

test('sizes switch unit at 1024 and stay at terabytes for huge values', () => {
  assert.equal(formatBytes(0, 'en'), '0 byte');
  assert.equal(formatBytes(1023, 'en'), '1,023 byte');
  assert.equal(formatBytes(1024, 'en'), '1 kB');
  assert.equal(formatBytes(38_693, 'en'), '37.8 kB');
  assert.equal(formatBytes(672_467_640_320, 'en'), '626.3 GB');
  assert.equal(formatBytes(5 * 1024 ** 5, 'en'), '5,120 TB');
  assert.equal(formatBytes(38_693, 'de'), '37,8 kB');
});

test('date-only ledger values stay plain dates instead of becoming UTC midnight in local time', () => {
  assert.equal(localTime('2020-03-04'), '2020-03-04');
  assert.equal(localDateTime('2020-03-04'), '2020-03-04');
  const pad = (n: number) => String(n).padStart(2, '0'); const today = new Date();
  const todayDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  assert.equal(localTime(todayDate), todayDate);
  assert.equal(localTime('2020-03-04 16:43'), '2020-03-04 16:43');
});

test('work locations inside the workspace read relative, while look-alike prefixes and outside paths stay absolute', () => {
  assert.equal(workspacePath('/ws', '/ws/Work/P/T'), 'Work/P/T');
  assert.equal(workspacePath('/ws/', '/ws/Work/P/T'), 'Work/P/T');
  assert.equal(workspacePath('C:\\ws', 'C:\\ws\\Work\\P\\T'), 'Work\\P\\T');
  assert.equal(workspacePath('/ws', '/ws-old/Work/P/T'), '/ws-old/Work/P/T');
  assert.equal(workspacePath('/ws', '/ws'), '/ws');
  assert.equal(workspacePath('/ws', '/elsewhere/repo'), '/elsewhere/repo');
  assert.equal(workspacePath('', '/ws/Work'), '/ws/Work');
});
