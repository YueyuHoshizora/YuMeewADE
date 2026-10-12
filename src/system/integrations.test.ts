import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsTerminalArgs } from './integrations.ts';

test('Windows Terminal receives semicolons as literals, not as its own subcommand separators', () => {
  assert.deepEqual(windowsTerminalArgs('C:\\Work\\a;b', 'npm i; npm test'), ['-d', 'C:\\Work\\a\\;b', 'powershell.exe', '-NoExit', '-Command', 'npm i\\; npm test']);
  assert.deepEqual(windowsTerminalArgs('C:\\Work\\repo', 'npm run dev'), ['-d', 'C:\\Work\\repo', 'powershell.exe', '-NoExit', '-Command', 'npm run dev']);
  // No command keeps PowerShell open in the folder without running anything.
  assert.deepEqual(windowsTerminalArgs('C:\\Work\\repo', ''), ['-d', 'C:\\Work\\repo', 'powershell.exe', '-NoExit', '-Command', '$null']);
});
