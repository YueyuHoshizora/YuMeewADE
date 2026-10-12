import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCommand, openTarget } from './open.ts';

test('files are revealed in their folder instead of being handed to a handler that could execute them', () => {
  assert.deepEqual(openCommand('darwin', '/repo/scripts/install.sh', false), { command: 'open', args: ['-R', '/repo/scripts/install.sh'] });
  assert.deepEqual(openCommand('win32', 'C:\\repo\\setup.bat', false), { command: 'explorer', args: ['/select,C:\\repo\\setup.bat'] });
  assert.deepEqual(openCommand('linux', '/repo/run.desktop', false), { command: 'xdg-open', args: ['/repo'] });
});

test('plain folders open, but a macOS folder with an extension may be an application bundle and is only revealed', () => {
  assert.deepEqual(openCommand('darwin', '/Users/me/Projects/app', true), { command: 'open', args: ['/Users/me/Projects/app'] });
  assert.deepEqual(openCommand('darwin', '/Users/me/Downloads/Tool.app', true), { command: 'open', args: ['-R', '/Users/me/Downloads/Tool.app'] });
  assert.deepEqual(openCommand('win32', 'C:\\Projects\\app', true), { command: 'explorer', args: ['C:\\Projects\\app'] });
  assert.deepEqual(openCommand('linux', '/home/me/app', true), { command: 'xdg-open', args: ['/home/me/app'] });
});

test('a symlink without an extension that points at an application bundle is revealed like the bundle itself', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'open-link-')));
  try {
    const bundle = path.join(root, 'Danger.app'); await fs.mkdir(bundle);
    await fs.symlink(bundle, path.join(root, 'innocent'));
    assert.deepEqual(await openTarget(path.join(root, 'innocent'), false, 'darwin'), { command: 'open', args: ['-R', bundle] });
    await fs.mkdir(path.join(root, 'plain'));
    assert.deepEqual(await openTarget(path.join(root, 'plain'), false, 'darwin'), { command: 'open', args: [path.join(root, 'plain')] });
    await assert.rejects(openTarget(path.join(root, 'missing'), false, 'darwin'), { code: 'not_found' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
