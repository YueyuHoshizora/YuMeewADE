import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidProjectName, isValidTaskId, nextTaskId } from './names.ts';

test('專案名白名單', () => {
  for (const ok of ['範例專案', 'My App', 'a.b-c_d', '專案 2026', 'COM10', 'Console']) assert.equal(isValidProjectName(ok), true, ok);
  for (const bad of ['', '..', 'a/b', 'a\\b', '.hidden', 'name.', 'name ', 'a..b', 'CON', 'nul.txt', 'CON .md', 'COM0', 'com¹', 'LPT³.txt', 'x'.repeat(65), 'a:b', 'a*b', 123, null])
    assert.equal(isValidProjectName(bad), false, String(bad));
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
