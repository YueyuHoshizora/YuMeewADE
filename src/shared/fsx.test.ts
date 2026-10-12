import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireWorkspaceLock, atomicWrite, readJson } from './fsx.ts';

test('workspace ownership is exclusive, refuses a live PID and takes over a dead PID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-lock-'));
  const file = path.join(root, '.yumeewade', 'core.lock');
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdout.write("ready");'], { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data');
    const release = await acquireWorkspaceLock(root, 3210);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).pid, process.pid);
    await assert.rejects(acquireWorkspaceLock(root, 3211), /已有核心程序/);
    await release();
    await assert.rejects(fs.access(file));
    await fs.writeFile(file, JSON.stringify({ pid: child.pid, port: 3212 }));
    await assert.rejects(acquireWorkspaceLock(root, 3213), /已有核心程序/);
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    const releaseStale = await acquireWorkspaceLock(root, 3214);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).port, 3214);
    await releaseStale();
    await assert.rejects(fs.access(file));
  } finally {
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('release does not remove a replacement owner and malformed locks fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-lock-'));
  const file = path.join(root, '.yumeewade', 'core.lock');
  try {
    const release = await acquireWorkspaceLock(root, 3210);
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, token: 'replacement' }));
    await release();
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).token, 'replacement');
    await fs.writeFile(file, '');
    await assert.rejects(acquireWorkspaceLock(root, 3211), /拒絕啟動/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a JSON file hand-saved with a byte order mark is still read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-json-'));
  try {
    const file = path.join(root, 'settings.json');
    await fs.writeFile(file, '\uFEFF{"enterToSend":true}');
    assert.deepEqual(await readJson(file, {}), { enterToSend: true });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a corrupted or wrongly shaped JSON file is reported by name, never as an internal crash or a silent default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-json-'));
  try {
    const file = path.join(root, 'settings.json');
    const corrupt = { status: 500, detail: 'file_corrupt', field: 'settings.json' };
    await fs.writeFile(file, '{"fullAccess": {"claude": false},');
    await assert.rejects(readJson(file, {}), corrupt);
    await fs.writeFile(file, 'null');
    await assert.rejects(readJson(file, {}), corrupt);
    await fs.writeFile(file, '[]');
    await assert.rejects(readJson(file, {}), corrupt);
    assert.deepEqual(await readJson(file, ['fallback']), []);
    await fs.writeFile(file, '{}');
    await assert.rejects(readJson(file, []), corrupt);
    // A null fallback means any JSON value is acceptable to the caller.
    await fs.writeFile(file, 'null');
    assert.equal(await readJson(file, null), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a write cut short by a full disk leaves the old file and no partial temp file behind', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-write-'));
  try {
    const file = path.join(root, 'task.md');
    await fs.writeFile(file, 'old');
    const write = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (target: string, data: string) => {
      await write(target, data.slice(0, 2));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    await assert.rejects(atomicWrite(file, 'new content'), { code: 'ENOSPC' });
    t.mock.restoreAll();
    assert.deepEqual(await fs.readdir(root), ['task.md']);
    assert.equal(await fs.readFile(file, 'utf8'), 'old');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
