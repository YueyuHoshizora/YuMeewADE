import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnCli, minimalEnv } from '../cli/process.ts';
import { DapTransport } from './dap-transport.ts';
import { DebuggerService } from './debugger.ts';
import { ExecutionService } from './commands.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';

for (const [source, expected] of [
  ['process.stdout.write("Content-Length: 2\\r\\nContent-Length: 2\\r\\n\\r\\n{}")', 'malformed'],
  ['process.stdout.write("Content-Length: 1048577\\r\\n\\r\\n")', 'malformed'],
  ['process.stdout.write("Content-Length: 1\\r\\n\\r\\n{")', 'malformed'],
  ['process.exit(3)', 'exit'],
] as const) test(`DAP transport rejects ${expected}: ${source}`, async () => {
  const child = spawnCli(process.execPath, ['-e', source], { env: minimalEnv([]), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const gate = Promise.withResolvers<string>();
  const transport = new DapTransport(child, () => assert.fail('unexpected event'), gate.resolve);
  try { await assert.rejects(transport.request('initialize')); assert.equal(await gate.promise, expected); } finally { transport.close(); }
});

test('DAP unanswered request fails closed on timeout', async context => {
  const child = spawnCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: minimalEnv([]), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = Promise.withResolvers<string>();
  const transport = new DapTransport(child, () => assert.fail('unexpected event'), gate.resolve);
  const pending = assert.rejects(transport.request('initialize'));
  context.mock.timers.tick(15_000);
  await pending; assert.equal(await gate.promise, 'timeout');
  context.mock.timers.tick(3500); transport.close(); context.mock.timers.reset();
});

// Real adapter events and Python execution cannot be advanced by this process's fake clock.
// Opt-in real installed adapter smoke: YUMEEWADE_DAP_PYTHON=/absolute/python node --test ...
test('real installed debugpy stdio launch, conditional breakpoint, scopes, evaluate, steps, disconnect', { skip: !process.env['YUMEEWADE_DAP_PYTHON'] }, () => withTmpWorkspace(async (ws) => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'Dap' });
  const task = await tasks.create('Dap', { title: 'DAP', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks }); const service = new DebuggerService(execution);
  const root = await execution.cwd('Dap', task.id);
  await fs.writeFile(path.join(root, 'main.py'), ['import time', 'for n in range(5):', '    value = n + 10', '    time.sleep(0.1)', 'time.sleep(60)'].join('\n'));
  try {
    const session = await service.launchDap('Dap', task.id, { adapter: [process.env['YUMEEWADE_DAP_PYTHON']!, '-m', 'debugpy.adapter'], type: 'python', program: 'main.py', stopOnEntry: false, breakpoints: [{ path: 'main.py', line: 4, condition: 'n == 2' }] });
    const state = () => service.state('Dap', task.id, session.id);
    async function paused(): Promise<void> { for (let i = 0; i < 400; i++) { if (state().status === 'paused' && state().frames.length) return; await delay(25); } assert.fail('real adapter did not pause'); }
    await paused(); assert.equal(state().frames[0]?.location.source?.path, 'main.py');
    const frame = state().frames[0]!; const scope = frame.scopes.find(s => s.objectId)!;
    assert.ok((await service.variables('Dap', task.id, session.id, scope.objectId!)).some(v => v.name === 'n'));
    assert.equal((await service.watch('Dap', task.id, session.id, frame.id, 'n')).value, '2');
    await assert.rejects(service.variables('Dap', task.id, session.id, '999999999'), { status: 400 });
    await assert.rejects(service.breakpoint('Dap', task.id, session.id, '../main.py', 1), { status: 400 });
    await assert.rejects(service.breakpoint('Dap', task.id, session.id, 'main.py', 2, undefined, true, state().revision - 1), { status: 409 });
    await service.action('Dap', task.id, session.id, 'stepOver'); await paused();
    await service.removeBreakpoint('Dap', task.id, session.id, state().breakpoints[0]!.id);
    await service.action('Dap', task.id, session.id, 'resume');
    for (let i = 0; i < 400 && state().status !== 'running'; i++) await delay(25);
    await service.action('Dap', task.id, session.id, 'pause'); await paused();
    service.detach('Dap', task.id, session.id);
    for (let i = 0; i < 400 && !['closed', 'failed'].includes(state().status); i++) await delay(25);
    assert.equal(state().status, 'closed');
  } finally { service.close(); await execution.stopAll(); }
}));

// Opt-in native smoke: set YUMEEWADE_DAP_LLDB and YUMEEWADE_DAP_CLANG to installed tool paths.
test('real LLDB keeps reused scope references bound to their stack frame', { skip: !process.env['YUMEEWADE_DAP_LLDB'] || !process.env['YUMEEWADE_DAP_CLANG'] }, () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'Native' });
  const task = await tasks.create('Native', { title: 'LLDB', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks }); const service = new DebuggerService(execution);
  const root = await execution.cwd('Native', task.id);
  await fs.writeFile(path.join(root, 'main.c'), ['int main(void) {', '  int value = 10;', '  value += 2;', '  value += 3;', '  return value;', '}'].join('\n'));
  try {
    const args = [...(process.env['YUMEEWADE_DAP_SYSROOT'] ? ['-isysroot', process.env['YUMEEWADE_DAP_SYSROOT']!] : []), '-g', '-O0', 'main.c', '-o', 'main'];
    const child = spawnCli(process.env['YUMEEWADE_DAP_CLANG']!, args, { cwd: root, env: minimalEnv([]), stdio: ['ignore', 'ignore', 'pipe'] });
    const compiled = Promise.withResolvers<number | null>(); let diagnostics = '';
    child.stderr?.on('data', data => { diagnostics += String(data); });
    child.once('error', compiled.reject); child.once('exit', compiled.resolve);
    assert.equal(await compiled.promise, 0, diagnostics);
    const session = await service.launchDap('Native', task.id, { adapter: [process.env['YUMEEWADE_DAP_LLDB']!], type: 'lldb', program: 'main', stopOnEntry: false, breakpoints: [{ path: 'main.c', line: 3 }] });
    const state = () => service.state('Native', task.id, session.id);
    async function paused(): Promise<void> {
      for (let i = 0; i < 400; i++) { if (state().status === 'paused' && state().frames.length) return; await delay(25); }
      assert.fail(`native adapter did not pause: ${JSON.stringify(state())}`);
    }
    await paused();
    const frame = state().frames[0]!; const local = frame.scopes.find(scope => scope.type === 'locals')!;
    assert.equal(frame.location.source?.path, 'main.c'); assert.equal(frame.location.line, 3);
    assert.ok(state().frames.length > 1);
    const callerLocal = state().frames[1]!.scopes.find(scope => scope.type === 'locals')!;
    assert.notEqual(local.objectId, callerLocal.objectId);
    await service.variables('Native', task.id, session.id, callerLocal.objectId!);
    const variables = await service.variables('Native', task.id, session.id, local.objectId!);
    assert.ok(variables.some(value => value.name === 'value' && value.value === '10'));
    assert.equal((await service.watch('Native', task.id, session.id, frame.id, 'value')).value, '10');
    await service.action('Native', task.id, session.id, 'stepOver'); await paused();
    assert.equal(state().frames[0]!.location.line, 4);
    assert.equal((await service.watch('Native', task.id, session.id, state().frames[0]!.id, 'value')).value, '12');
    service.detach('Native', task.id, session.id);
    for (let i = 0; i < 400 && !['closed', 'failed'].includes(state().status); i++) await delay(25);
    assert.equal(state().status, 'closed');
  } finally { service.close(); await execution.stopAll(); }
}));
