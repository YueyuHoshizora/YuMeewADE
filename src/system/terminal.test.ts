import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ExecutionService } from './commands.ts';
import { TerminalService } from './terminal.ts';

// Real PTYs, process-table snapshots and OS reaping cannot be driven by fake timers.
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 250; n++) { if (check()) return; await delay(20); }
  assert.fail('condition not reached');
}

test('execution and terminal resolve relative PATH against task cwd', { skip: process.platform === 'win32' }, () => withTmpWorkspace(async (ws, dir) => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: 'Run', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks });
  const terminal = new TerminalService(execution);
  const original = process.cwd();
  try {
    const cwd = await execution.cwd('P', task.id);
    for (const [folder, label] of [[dir, 'SERVER'], [cwd, 'TASK']] as const) {
      await fs.mkdir(path.join(folder, 'bin'), { recursive: true });
      const file = path.join(folder, 'bin', 'cwd-tool');
      await fs.writeFile(file, `#!/bin/sh\nprintf '${label}\\n'\n`, { mode: 0o700 });
    }
    process.chdir(dir);
    const run = await execution.start('P', task.id, { command: 'cwd-tool', env: { PATH: 'bin' } });
    await until(() => execution.output('P', task.id, run.id).status !== 'running');
    const lease = await terminal.start('P', task.id, { command: 'cwd-tool', env: { PATH: 'bin' } });
    await until(() => terminal.output('P', task.id, lease.session.id, lease.owner).status !== 'running');
    assert.equal(execution.output('P', task.id, run.id).output.map(row => row.text).join('').trim(), 'TASK');
    assert.equal(terminal.output('P', task.id, lease.session.id, lease.owner).output.map(row => row.text).join('').trim(), 'TASK');
  } finally { process.chdir(original); await terminal.stopAll(); await execution.stopAll(); }
}));
