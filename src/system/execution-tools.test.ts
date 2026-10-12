import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectLedger } from '../ledger/projects.ts';
import { stripVTControlCharacters } from 'node:util';
import { TaskLedger } from '../ledger/tasks.ts';
import type { Workspace } from '../ledger/workspace.ts';
import { AppError } from '../shared/errors.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ExecutionService } from './commands.ts';
import { DebuggerService } from './debugger.ts';
import { TerminalService } from './terminal.ts';

async function setup(ws: Workspace) {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'Tools' });
  const task = await tasks.create('Tools', { title: 'Tools', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks });
  return { execution, task, projects, tasks };
}
// Native PTY and Inspector events come from real OS processes; advancing fake clocks cannot produce them.
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) { if (check()) return; await delay(20); }
  assert.fail('observable condition not reached');
}

test('named configurations persist by task and run with confined cwd and explicit safe environment', () => withTmpWorkspace(async ws => {
  const { execution, task, projects, tasks } = await setup(ws);
  const root = await execution.cwd('Tools', task.id); await fs.mkdir(path.join(root, 'sub'));
  const spec = { name: 'check', command: process.execPath, args: ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),mode:process.env.MODE}))'], kind: 'command', cwd: 'sub', env: { MODE: 'test' } };
  try {
    await execution.saveConfiguration('Tools', task.id, spec);
    const restarted = new ExecutionService({ ws, projects, tasks });
    try {
      assert.deepEqual(await restarted.configurations('Tools', task.id), [spec]);
      const other = await tasks.create('Tools', { title: 'Other', workspace: 'direct' });
      assert.deepEqual(await restarted.configurations('Tools', other.id), []);
      const run = await restarted.startConfiguration('Tools', task.id, 'check');
      await until(() => restarted.output('Tools', task.id, run.id).status !== 'running');
      assert.deepEqual(JSON.parse(restarted.output('Tools', task.id, run.id).output.map(o => o.text).join('')), { cwd: path.join(root, 'sub'), mode: 'test' });
      await restarted.saveConfiguration('Tools', task.id, { ...spec, env: { MODE: 'updated' } });
      assert.equal((await restarted.configurations('Tools', task.id)).length, 1);
      assert.equal((await restarted.configurations('Tools', task.id))[0]!.env['MODE'], 'updated');
      await restarted.removeConfiguration('Tools', task.id, 'check');
      assert.deepEqual(await restarted.configurations('Tools', task.id), []);
    } finally { await restarted.stopAll(); }
    for (const env of [{ NODE_OPTIONS: '--inspect=0.0.0.0:9229' }, { API_TOKEN: 'secret' }, { MODE: 'a'.repeat(4097) }, Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`VALUE_${n}`, 'x']))]) await assert.rejects(execution.saveConfiguration('Tools', task.id, { ...spec, env }), { status: 400 });
    await assert.rejects(execution.saveConfiguration('Tools', task.id, { ...spec, cwd: '..' }), { status: 400 });
    await assert.rejects(execution.startConfiguration('Tools', task.id, 'missing'), { status: 404 });
  } finally { await execution.stopAll(); }
}));

test('configured cwd follows realpaths and rejects symlink escape before spawning', () => withTmpWorkspace(async (ws, dir) => {
  const { execution, task } = await setup(ws);
  try {
    const root = await execution.cwd('Tools', task.id);
    await fs.symlink(dir, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(execution.start('Tools', task.id, { command: process.execPath, cwd: 'escape' }), { status: 400 });
    assert.equal(execution.isRunning('Tools', task.id), false);
  } finally { await execution.stopAll(); }
}));

test('native embedded PTY has TTY stdin/stdout, input, resize, output bounds and capability ownership', () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws);
  const terminal = new TerminalService(execution, { outputBytes: 1024 });
  const script = 'process.stdin.setRawMode(true);console.log("READY",process.stdin.isTTY,process.stdout.isTTY,process.stdout.columns,process.stdout.rows);process.stdout.on("resize",()=>console.log("SIZE",process.stdout.columns,process.stdout.rows));process.stdin.on("data",x=>{console.log("INPUT",x.toString());if(x.toString()==="z")console.log("x".repeat(10000))});setInterval(()=>{},1000)';
  try {
    const lease = await terminal.start('Tools', task.id, { command: process.execPath, args: ['-e', script], cols: 80, rows: 24 });
    const snapshot = () => terminal.output('Tools', task.id, lease.session.id, lease.owner);
    await until(() => stripVTControlCharacters(snapshot().output.map(o => o.text).join('')).includes('READY true true 80 24'));
    assert.throws(() => terminal.output('Tools', task.id, lease.session.id, '0'.repeat(64)), { status: 403 });
    assert.throws(() => terminal.output('Tools', 'different', lease.session.id, lease.owner), { status: 404 });
    terminal.input('Tools', task.id, lease.session.id, lease.owner, 'q');
    await until(() => snapshot().output.map(o => o.text).join('').includes('INPUT q'));
    terminal.resize('Tools', task.id, lease.session.id, lease.owner, 92, 31);
    await until(() => stripVTControlCharacters(snapshot().output.map(o => o.text).join('')).includes('SIZE 92 31'));
    assert.equal(snapshot().cols, 92);
    assert.throws(() => terminal.resize('Tools', task.id, lease.session.id, lease.owner, 1000, 31), { status: 400 });
    terminal.input('Tools', task.id, lease.session.id, lease.owner, 'z'); await until(() => snapshot().truncated);
    assert.ok(snapshot().output.reduce((n, o) => n + Buffer.byteLength(o.text), 0) <= 1024);
    await terminal.stop('Tools', task.id, lease.session.id, lease.owner);
    assert.equal(snapshot().status, 'stopped');
    assert.throws(() => terminal.input('Tools', task.id, lease.session.id, lease.owner, 'q'), { status: 409 });
  } finally { await terminal.stopAll(); await execution.stopAll(); }
}));

test('multiple same-task terminals reserve independent capacity and stop independently', () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws);
  const terminal = new TerminalService(execution, { concurrent: 2 });
  try {
    const leases = await Promise.all([1, 2].map(() => terminal.start('Tools', task.id, { command: process.execPath, args: ['-e', 'console.log("READY");setInterval(()=>{},1000)'] })));
    assert.equal(terminal.active(), 2);
    assert.notEqual(leases[0]!.session.id, leases[1]!.session.id);
    await assert.rejects(terminal.start('Tools', task.id), { status: 503 });
    const first = leases[0]!; const second = leases[1]!;
    assert.throws(() => terminal.output('Tools', task.id, second.session.id, first.owner), { status: 403 });
    await terminal.stop('Tools', task.id, first.session.id, first.owner);
    assert.equal(terminal.output('Tools', task.id, second.session.id, second.owner).status, 'running');
    assert.equal(terminal.active(), 1);
    const third = await terminal.start('Tools', task.id, { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
    assert.equal(third.session.status, 'running');
  } finally { await terminal.stopAll(); await execution.stopAll(); }
}));

test('a relative terminal command resolves in the task folder, not the core\'s working directory', { skip: process.platform === 'win32' }, () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws);
  const terminal = new TerminalService(execution);
  const script = path.join(ws.projectDir('Tools'), 'bin', 'hello');
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(script, '#!/bin/sh\necho HELLO-RELATIVE\n', { mode: 0o755 });
  try {
    const lease = await terminal.start('Tools', task.id, { command: './bin/hello' });
    await until(() => terminal.output('Tools', task.id, lease.session.id, lease.owner).output.map(o => o.text).join('').includes('HELLO-RELATIVE'));
  } finally { await terminal.stopAll(); await execution.stopAll(); }
}));

test('terminal synchronously reserves task and honors trust hook before any PTY launch', () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const terminal = new TerminalService(execution, { concurrent: 1, beforeStart: async () => { entered.resolve(); await release.promise; throw new AppError('forbidden'); } });
  try {
    const pending = terminal.start('Tools', task.id);
    assert.equal(terminal.isRunning('Tools', task.id), true);
    await entered.promise;
    await assert.rejects(terminal.start('Tools', task.id), { status: 503 });
    release.resolve(); await assert.rejects(pending, { status: 403 });
    assert.equal(terminal.isBusy(), false);
  } finally { release.resolve(); await terminal.stopAll(); await execution.stopAll(); }
}));

test('real Node Inspector provides root-bound breakpoints, local variables, stack and stepping', () => withTmpWorkspace(async ws => {
  const { execution, task } = await setup(ws); const debuggerService = new DebuggerService(execution);
  const root = await execution.cwd('Tools', task.id);
  const script = ['function add(n) {', '  const bump = n + 1;', '  return bump;', '}', 'function inner() {', '  const local = { answer: 42 };', '  const result = add(local.answer);', '  console.log(result);', '}', 'setTimeout(inner, 50);', 'setInterval(() => {}, 1000);'].join('\n');
  await fs.writeFile(path.join(root, 'debug.cjs'), script);
  try {
    const run = await execution.start('Tools', task.id, { command: 'node', kind: 'debug', args: ['debug.cjs'] });
    const session = await debuggerService.attach('Tools', task.id, run.id);
    const state = () => debuggerService.state('Tools', task.id, session.id);
    await until(() => state().status === 'paused');
    await debuggerService.breakpoint('Tools', task.id, session.id, 'debug.cjs', 7);
    await assert.rejects(debuggerService.breakpoint('Tools', task.id, session.id, '../escape.cjs', 1), { status: 400 });
    await debuggerService.action('Tools', task.id, session.id, 'resume');
    await until(() => state().status === 'paused' && state().frames[0]?.location.line === 7);
    const localScope = state().frames[0]!.scopes.find(s => s.type === 'local')!;
    const locals = await debuggerService.variables('Tools', task.id, session.id, localScope.objectId!);
    const local = locals.find(v => v.name === 'local')!; assert.ok(local.objectId);
    const properties = await debuggerService.variables('Tools', task.id, session.id, local.objectId!);
    assert.equal(properties.find(v => v.name === 'answer')?.value, '42');
    await assert.rejects(debuggerService.variables('Tools', task.id, session.id, 'arbitrary-object'), { status: 400 });
    await debuggerService.action('Tools', task.id, session.id, 'stepInto');
    await until(() => state().status === 'paused' && state().frames[0]?.name === 'add');
    assert.ok(state().frames.length >= 2);
    await debuggerService.action('Tools', task.id, session.id, 'stepOver');
    await until(() => state().status === 'paused' && state().frames[0]?.location.line === 3);
    await debuggerService.action('Tools', task.id, session.id, 'stepOut');
    await until(() => state().status === 'paused' && state().frames[0]?.name === 'inner');
    const point = state().breakpoints[0]!; await debuggerService.removeBreakpoint('Tools', task.id, session.id, point.id);
    assert.equal(state().breakpoints.length, 0);
    await debuggerService.action('Tools', task.id, session.id, 'resume'); await until(() => state().status === 'running');
    await debuggerService.action('Tools', task.id, session.id, 'pause'); await until(() => state().status === 'paused');
    await execution.stop('Tools', task.id, run.id); assert.equal(state().status, 'closed');
    assert.throws(() => debuggerService.state('Tools', 'other', session.id), { status: 404 });
  } finally { debuggerService.close(); await execution.stopAll(); }
}));
