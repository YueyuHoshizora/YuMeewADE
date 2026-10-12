import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidProjectName, isValidTaskId, isWindowsDeviceName, nextTaskId } from './names.ts';

test('專案名白名單', () => {
  for (const ok of ['範例專案', 'My App', 'a.b-c_d', '專案 2026', 'COM10', 'Console']) assert.equal(isValidProjectName(ok), true, ok);
  for (const bad of ['', '..', 'a/b', 'a\\b', '.hidden', 'name.', 'name ', 'a..b', 'CON', 'nul.txt', 'CON .md', 'COM0', 'com¹', 'LPT³.txt', 'x'.repeat(65), 'a:b', 'a*b', 123, null])
    assert.equal(isValidProjectName(bad), false, String(bad));
});

test('Windows 裝置名判斷涵蓋副檔名、尾端空白與上標數字，一般名稱不受影響', () => {
  for (const device of ['CON', 'con.txt', 'NUL .md', 'COM¹', 'lpt0.log', 'AUX.tar.gz']) assert.equal(isWindowsDeviceName(device), true, device);
  for (const file of ['CONSOLE', 'com10', 'my-con', '.con', 'nulls.txt']) assert.equal(isWindowsDeviceName(file), false, file);
});

test('作業 ID 白名單', () => {
  assert.equal(isValidTaskId('20261010-001'), true);
  assert.equal(isValidTaskId('task_A-1'), true);
  for (const bad of ['', '-x', '中文', 'a b', 'a/b', '..', 'COM1', 'lpt0', undefined]) assert.equal(isValidTaskId(bad), false, String(bad));
});

test('nextTaskId 依當日序號遞增', () => {
  const now = new Date(2026, 9, 10);
  assert.equal(nextTaskId([], now), '20261010-001');
  assert.equal(nextTaskId(['20261010-001', '20261010-007', '20261009-099'], now), '20261010-008');
});
