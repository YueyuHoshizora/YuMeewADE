import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import type { Workspace } from '../ledger/workspace.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ExecutionService, type ExecutionOptions } from './commands.ts';
import { IntegrationService, loopbackUrl } from './integrations.ts';

async function setup(ws: Workspace, options: Partial<ExecutionOptions> = {}) {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: 'Run', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks, ...options });
  return { execution, task, tasks, projects };
}
// Real subprocess/inspector integration: observable OS output and process death cannot use fake timers.
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(20); }
  assert.fail('condition not reached');
}

test('execution streams incremental stdout/stderr in task cwd and stops', () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws);
  const cwd = await execution.cwd('P', task.id);
  try {
    const run = await execution.start('P', task.id, { command: process.execPath, args: ['-e', 'console.log(process.cwd());setInterval(()=>{console.log("tick");console.error("err")},100)'] });
    await until(() => execution.output('P', task.id, run.id).sequence > 2);
    const first = execution.output('P', task.id, run.id);
    assert.ok(first.output.some(o => o.stream === 'stderr'));
    assert.ok(first.output.some(o => o.text.includes(cwd)));
    await until(() => execution.output('P', task.id, run.id).sequence > first.sequence);
    assert.ok(execution.output('P', task.id, run.id, first.sequence).output.every(o => o.sequence > first.sequence));
    await execution.stop('P', task.id, run.id);
    assert.equal(execution.output('P', task.id, run.id).status, 'stopped');
  } finally { await execution.stopAll(); }
}));

test('execution limits output, concurrency, timeout, and shutdown', () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws, { concurrent: 1, outputBytes: 128, timeoutMs: 1000 });
  try {
    const run = await execution.start('P', task.id, { command: process.execPath, args: ['-e', 'console.log("x".repeat(10000));setInterval(()=>{},1000)'] });
    await assert.rejects(execution.start('P', task.id, { command: process.execPath }), { status: 503 });
    await until(() => execution.output('P', task.id, run.id).status !== 'running');
    const result = execution.output('P', task.id, run.id);
    assert.equal(result.timedOut, true); assert.equal(result.truncated, true);
    assert.ok(result.output.reduce((n, o) => n + Buffer.byteLength(o.text), 0) <= 128);
    const second = await execution.start('P', task.id, { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
    await execution.stopAll();
    assert.equal(execution.output('P', task.id, second.id).status, 'stopped');
    await assert.rejects(execution.start('P', task.id, { command: process.execPath }), { status: 503 });
  } finally { await execution.stopAll(); }
}));

test('execution rejects invalid names, symlink escapes and inspector flags', () => withTmpWorkspace(async (ws, dir) => {
  const { execution, task, tasks } = await setup(ws);
  try {
    await assert.rejects(execution.start('../P', task.id, { command: process.execPath }), { status: 400 });
    await assert.rejects(execution.start('P', task.id, { command: 'node', args: ['--inspect=0.0.0.0:9229'], kind: 'debug' }), { status: 400 });
    const link = path.join(ws.workDir, 'escape');
    await fs.symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    await tasks.update('P', task.id, { workdir: link });
    await assert.rejects(execution.start('P', task.id, { command: process.execPath }), { status: 400 });
  } finally { await execution.stopAll(); }
}));

test('preview and inspector only permit loopback URLs without credentials', () => {
  for (const url of ['http://localhost:3000/', 'https://127.0.0.1:4443/', 'http://[::1]:8888/']) assert.ok(loopbackUrl(url));
  for (const url of ['https://example.com:4443', 'http://localhost.evil:3000', 'http://u:p@localhost:3000', 'file:///tmp/a', 'http://0.0.0.0:3000', 'http://localhost/']) assert.throws(() => loopbackUrl(url), { status: 400 });
  assert.ok(loopbackUrl('ws://127.0.0.1:9229/abcdef', true));
  assert.throws(() => loopbackUrl('ws://example.com:9229/abcdef', true), { status: 400 });
});


test('Node debugger launches actual inspector bound to loopback', () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws);
  try {
    const run = await execution.start('P', task.id, { command: 'node', kind: 'debug', args: ['-e', 'console.log("debug")'] });
    await until(() => Boolean(execution.output('P', task.id, run.id).inspectorUrl));
    assert.match(execution.output('P', task.id, run.id).inspectorUrl!, /^ws:\/\/127\.0\.0\.1:\d+\//u);
  } finally { await execution.stopAll(); }
}));

test('stop kills descendant process group', { skip: process.platform === 'win32' }, () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws);
  try {
    const run = await execution.start('P', task.id, { command: process.execPath, args: ['-e', 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)'] });
    await until(() => execution.output('P', task.id, run.id).sequence > 0);
    const pid = Number(execution.output('P', task.id, run.id).output[0]!.text.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    await execution.stop('P', task.id, run.id);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally { await execution.stopAll(); }
}));

test('configured native terminal runs with real PTY and task cwd', { skip: process.platform !== 'darwin' }, () => withTmpWorkspace(async (ws, dir) => {
  const { execution, task } = await setup(ws);
  const record = path.join(dir, 'terminal.json');
  const integration = new IntegrationService(execution, { terminal: {
    command: '/usr/bin/script',
    args: ['-q', '/dev/null', process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[2],JSON.stringify({cwd:process.cwd(),folder:process.argv[1],tty:process.stdin.isTTY===true}))', '{cwd}', record],
  } });
  try {
    await integration.terminal('P', task.id);
    let actual: { cwd: string; folder: string; tty: boolean } | undefined;
    for (let n = 0; n < 200 && !actual; n++) {
      try { actual = JSON.parse(await fs.readFile(record, 'utf8')) as typeof actual; }
      catch { await delay(20); }
    }
    const cwd = await execution.cwd('P', task.id);
    assert.deepEqual(actual, { cwd, folder: cwd, tty: true });
  } finally { await execution.stopAll(); }
}));

test('manual commands filter ambient secret variables', () => withTmpWorkspace(async ws => {
  const previous = process.env['YUMEEWADE_EXECUTION_CANARY'];
  process.env['YUMEEWADE_EXECUTION_CANARY'] = 'private-value';
  const { execution, task } = await setup(ws);
  try {
    const run = await execution.start('P', task.id, { command: process.execPath, args: ['-e', 'console.log(process.env.YUMEEWADE_EXECUTION_CANARY ?? "absent")'] });
    await until(() => execution.output('P', task.id, run.id).status !== 'running');
    assert.equal(execution.output('P', task.id, run.id).output.map(o => o.text).join('').trim(), 'absent');
  } finally {
    await execution.stopAll();
    if (previous === undefined) delete process.env['YUMEEWADE_EXECUTION_CANARY'];
    else process.env['YUMEEWADE_EXECUTION_CANARY'] = previous;
  }
}));

test('execution reserves task before IO and rejects AI busy before and after IO', () => withTmpWorkspace(async ws => {
  let busy = true;
  let checks = 0;
  const { execution, task } = await setup(ws, { isRunning: () => { checks++; return busy || checks === 2; } });
  try {
    await assert.rejects(execution.start('P', task.id, { command: process.execPath }), { status: 409 });
    assert.equal(execution.isRunning('P', task.id), false);
    busy = false; checks = 0;
    await assert.rejects(execution.start('P', task.id, { command: process.execPath }), { status: 409 });
    assert.equal(execution.isRunning('P', task.id), false);
    checks = 10;
    const pending = execution.start('P', task.id, { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
    assert.equal(execution.isRunning('P', task.id), true);
    await assert.rejects(execution.start('P', task.id, { command: process.execPath }), { status: 409 });
    const entry = await pending;
    assert.equal(execution.isRunning('P', task.id), true);
    await execution.stop('P', task.id, entry.id);
    assert.equal(execution.isRunning('P', task.id), false);
  } finally { await execution.stopAll(); }
}));

test('parent exit kills descendants holding inherited stdio without waiting for command timeout', { skip: process.platform === 'win32', timeout: 8000 }, () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws, { timeoutMs: 60000 });
  try {
    const run = await execution.start('P', task.id, { command: process.execPath, args: ['-e', 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});console.log(c.pid);c.unref();'] });
    await until(() => execution.output('P', task.id, run.id).status !== 'running');
    const result = execution.output('P', task.id, run.id);
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    const pid = Number(result.output.map(row => row.text).join('').trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally { await execution.stopAll(); }
}));
