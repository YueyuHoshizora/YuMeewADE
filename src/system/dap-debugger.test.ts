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
