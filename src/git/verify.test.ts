import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import type { Workspace } from '../ledger/workspace.ts';
import { parseConfig } from '../shared/config.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { VerifyService } from './verify.ts';

async function setup(ws: Workspace, verify: string, limits = '', isRunning = () => false) {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P', verify });
  const task = await tasks.create('P', { title: 'Verify', workspace: 'direct' });
  const service = new VerifyService({ ws, projects, tasks, config: parseConfig(limits, null), isRunning });
  return { service, projects, tasks, task };
}

const nodeCommand = (code: string) => `"${process.execPath}" -e "${code}"`;

test('verify reports passing and failing exits', () => withTmpWorkspace(async ws => {
  const { service, projects, task } = await setup(ws, nodeCommand('process.stdout.write(\'passed\')'));
  try {
    const passed = await service.run('P', task.id);
    assert.equal(passed.ok, true); assert.equal(passed.exitCode, 0); assert.equal(passed.output, 'passed');
    await projects.update('P', { verify: nodeCommand('process.exit(7)') });
    const failed = await service.run('P', task.id);
    assert.equal(failed.ok, false); assert.equal(failed.exitCode, 7); assert.equal(failed.timedOut, false);
  } finally { await service.stopAll(); }
}));

test('verify runs a direct task in a project body folder outside the workspace', () => withTmpWorkspace(async (ws, dir) => {
  const body = path.join(dir, 'external-body');
  await fs.mkdir(body);
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P', body, verify: nodeCommand('process.stdout.write(require(\'node:path\').basename(process.cwd()))') });
  const task = await tasks.create('P', { title: 'Direct', workspace: 'direct' });
  const service = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
  try {
    const result = await service.run('P', task.id);
    assert.equal(result.ok, true);
    assert.equal(result.output, 'external-body');
  } finally { await service.stopAll(); }
}));

test('verify bounds the combined output tail', () => withTmpWorkspace(async ws => {
  const { service, projects, task } = await setup(ws, nodeCommand('process.stdout.write(\'a\'.repeat(200000)+\'TAIL\')'), 'limits:\n  verifyOutputBytes: 64\n');
  try {
    const result = await service.run('P', task.id);
    assert.equal(result.ok, true); assert.equal(result.truncated, true);
    assert.equal(Buffer.byteLength(result.output), 64); assert.ok(result.output.endsWith('TAIL'));
    await projects.update('P', { verify: nodeCommand('process.stderr.write(\'stderr-tail\')') });
    assert.equal((await service.run('P', task.id)).output, 'stderr-tail');
  } finally { await service.stopAll(); }
}));

test('verify filters ambient secrets', () => withTmpWorkspace(async ws => {
  const previous = process.env['YUMEEWADE_VERIFY_CANARY'];
  process.env['YUMEEWADE_VERIFY_CANARY'] = 'secret-canary';
  const { service, task } = await setup(ws, nodeCommand('process.stdout.write(process.env.YUMEEWADE_VERIFY_CANARY || \'absent\')'));
  try { assert.equal((await service.run('P', task.id)).output, 'absent'); }
  finally {
    await service.stopAll();
    if (previous === undefined) delete process.env['YUMEEWADE_VERIFY_CANARY'];
    else process.env['YUMEEWADE_VERIFY_CANARY'] = previous;
  }
}));

test('verify rejects missing command, missing workdir and escaped workdir', () => withTmpWorkspace(async (ws, dir) => {
  const { service, projects, tasks, task } = await setup(ws, '');
  try {
    await assert.rejects(service.run('P', task.id), { status: 400 });
    await projects.update('P', { verify: nodeCommand('process.exit(0)') });
    await tasks.update('P', task.id, { workdir: path.join(ws.workDir, 'missing') });
    await assert.rejects(service.run('P', task.id), { status: 400 });
    await tasks.update('P', task.id, { workdir: dir });
    await assert.rejects(service.run('P', task.id), { status: 400 });
    const link = path.join(ws.workDir, 'escaped');
    await fs.symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    await tasks.update('P', task.id, { workdir: link });
    await assert.rejects(service.run('P', task.id), { status: 400 });
  } finally { await service.stopAll(); }
}));

test('verify times out and rejects concurrent requests', { skip: process.platform === 'win32' }, () => withTmpWorkspace(async ws => {
  // This integration test exercises the real shell/process-group timeout.
  const { service, task } = await setup(ws, 'sleep 30', 'limits:\n  verifySeconds: 1\n');
  try {
    const running = service.run('P', task.id);
    assert.throws(() => service.run('P', task.id), { status: 409 });
    const result = await running;
    assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.ok(result.ms < 3000);
  } finally { await service.stopAll(); }
}));

test('verify shutdown stops running children', () => withTmpWorkspace(async ws => {
  const ready = Promise.withResolvers<void>();
  let checks = 0;
  const { service, task } = await setup(ws, nodeCommand('setTimeout(()=>{},30000)'), '', () => {
    if (++checks === 2) ready.resolve();
    return false;
  });
  const running = service.run('P', task.id);
  await ready.promise;
  await service.stopAll();
  const result = await running;
  assert.equal(result.ok, false); assert.equal(result.timedOut, false); assert.ok(result.ms < 3000);
  assert.throws(() => service.run('P', task.id), { status: 409 });
}));

test('verify status keeps the latest result per task until invalidated', () => withTmpWorkspace(async ws => {
  const { service, projects, task } = await setup(ws, nodeCommand('process.exit(0)'));
  try {
    assert.equal(service.status('P', task.id), null);
    await service.run('P', task.id);
    assert.equal(service.status('P', task.id)?.ok, true);
    await projects.update('P', { verify: nodeCommand('process.exit(3)') });
    await service.run('P', task.id);
    const failed = service.status('P', task.id);
    assert.equal(failed?.ok, false); assert.equal(failed?.exitCode, 3);
    assert.equal(service.status('P', 'other-task'), null);
    service.invalidate('P', task.id);
    assert.equal(service.status('P', task.id), null);
  } finally { await service.stopAll(); }
}));
