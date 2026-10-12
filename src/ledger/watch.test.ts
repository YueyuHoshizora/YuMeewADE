import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LedgerWatcher } from './watch.ts';
import { Workspace } from './workspace.ts';

// fs.watch delivery is platform asynchronous; real bounded polling exercises it.
async function until(check: () => boolean, retry?: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'watch event timed out');
    await retry?.();
    await delay(20);
  }
}

test('external task edits identify project/task; later projects and task directories are discovered; close stops events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-watch-'));
  const ws = new Workspace(root);
  const events: Array<{ project?: string; task?: string }> = [];
  const watcher = new LedgerWatcher(ws, (project, task) => events.push({ ...(project ? { project } : {}), ...(task ? { task } : {}) }));
  try {
    await ws.init();
    await fs.mkdir(ws.tasksDir('First'), { recursive: true });
    await watcher.start();
    await fs.writeFile(ws.taskFile('First', 'task-1'), 'external');
    // macOS FSEvents 可能漏掉監看剛建立時的第一個事件，所以重寫直到收到。
    await until(() => events.some(event => event.project === 'First' && event.task === 'task-1'), async () => {
      await fs.writeFile(ws.taskFile('First', 'task-1'), 'external');
    });
    await fs.mkdir(path.join(ws.projectDir('Later'), '.ai'), { recursive: true });
    await until(() => events.some(event => event.project === 'Later'), async () => {
      await fs.writeFile(path.join(ws.projectDir('Later'), 'PROJECT.md'), 'project');
    });
    await fs.mkdir(ws.tasksDir('Later'));
    await until(() => events.some(event => event.project === 'Later' && event.task === 'task-2'), async () => {
      await fs.writeFile(ws.taskFile('Later', 'task-2'), 'new task');
    });
    // 前面重試寫入的事件可能延遲送達；等事件數穩定後才量測「不該出現的事件」。
    let before = -1;
    while (before !== events.length) {
      before = events.length;
      await delay(200);
    }
    await fs.mkdir(path.join(ws.workDir, 'Later'), { recursive: true });
    await fs.writeFile(path.join(ws.workDir, 'Later', 'body.txt'), 'ignored');
    await fs.mkdir(path.join(ws.projectDir('Later'), 'node_modules'));
    await delay(100);
    assert.equal(events.length, before);
    watcher.close();
    await fs.writeFile(ws.taskFile('First', 'task-1'), 'closed');
    await delay(100);
    assert.equal(events.length, before);
  } finally {
    watcher.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Windows refuses to rename a directory that a watcher holds open, so the replacement cannot be staged there.
test('a task directory replaced at the same path (moved away and recreated) is watched again', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-watch-'));
  const ws = new Workspace(root);
  const events: Array<{ project?: string; task?: string }> = [];
  const watcher = new LedgerWatcher(ws, (project, task) => events.push({ ...(project ? { project } : {}), ...(task ? { task } : {}) }));
  try {
    await ws.init();
    await fs.mkdir(ws.tasksDir('P'), { recursive: true });
    await watcher.start();
    await until(() => events.some(event => event.task === 'task-1'), async () => { await fs.writeFile(ws.taskFile('P', 'task-1'), 'first'); });
    // Both happen before the debounced rebuild runs, so the path never looks missing to it.
    await fs.rename(ws.tasksDir('P'), `${ws.tasksDir('P')}.old`);
    await fs.mkdir(ws.tasksDir('P'));
    await until(() => events.some(event => event.task === 'task-2'), async () => { await fs.writeFile(ws.taskFile('P', 'task-2'), 'second'); });
  } finally {
    watcher.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
