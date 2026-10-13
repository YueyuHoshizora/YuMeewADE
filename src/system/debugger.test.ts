import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { ExecutionService } from './commands.ts';
import { DebuggerService } from './debugger.ts';

// Real Inspector child-process events cannot be advanced by this process's fake clock.
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) { if (check()) return; await delay(20); }
  assert.fail('debugger observable condition not reached');
}

for (const missing of ['renamed', 'deleted', 'not-directory']) test(`Inspector restores live breakpoints after a persisted file is ${missing}`, () => withTmpWorkspace(async (ws, dir) => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'Debug' });
  const task = await tasks.create('Debug', { title: 'Restore', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks });
  const metadata = path.join(dir, 'breakpoints.json');
  const service = new DebuggerService(execution, { metadataFile: async () => metadata });
  const root = await execution.cwd('Debug', task.id);
  await fs.writeFile(path.join(root, 'main.cjs'), 'setInterval(() => {}, 1000);\n');
  await fs.mkdir(path.join(root, 'old'));
  await fs.writeFile(path.join(root, 'old', 'source.cjs'), 'const value = 1;\n');
  try {
    const first = await execution.start('Debug', task.id, { command: 'node', kind: 'debug', args: ['main.cjs'] });
    const original = await service.attach('Debug', task.id, first.id);
    await until(() => service.state('Debug', task.id, original.id).status === 'paused');
    await service.breakpoint('Debug', task.id, original.id, 'old/source.cjs', 1);
    await service.breakpoint('Debug', task.id, original.id, 'main.cjs', 1);
    service.detach('Debug', task.id, original.id);
    await execution.stop('Debug', task.id, first.id);
    if (missing === 'renamed') await fs.rename(path.join(root, 'old', 'source.cjs'), path.join(root, 'old', 'renamed.cjs'));
    else await fs.unlink(path.join(root, 'old', 'source.cjs'));
    if (missing === 'not-directory') { await fs.rmdir(path.join(root, 'old')); await fs.writeFile(path.join(root, 'old'), 'not a directory'); }
    const second = await execution.start('Debug', task.id, { command: 'node', kind: 'debug', args: ['main.cjs'] });
    const restored = await service.attach('Debug', task.id, second.id);
    await until(() => service.state('Debug', task.id, restored.id).status === 'paused');
    assert.deepEqual(service.state('Debug', task.id, restored.id).breakpoints.map(point => point.path), ['main.cjs']);
    assert.equal(execution.output('Debug', task.id, second.id).status, 'running');
    await service.breakpoint('Debug', task.id, restored.id, 'main.cjs', 2);
    assert.deepEqual(JSON.parse(await fs.readFile(metadata, 'utf8')).breakpoints.map((point: { path: string }) => point.path), ['main.cjs', 'main.cjs']);
  } finally { service.close(); await execution.stopAll(); }
}));

test('Inspector metadata restore still rejects unsafe paths and malformed missing-file entries', () => withTmpWorkspace(async (ws, dir) => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'Debug' });
  const task = await tasks.create('Debug', { title: 'Metadata validation', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks });
  const metadata = path.join(dir, 'breakpoints.json');
  const service = new DebuggerService(execution, { metadataFile: async () => metadata });
  const root = await execution.cwd('Debug', task.id);
  await fs.writeFile(path.join(root, 'main.cjs'), 'setInterval(() => {}, 1000);\n');
  await fs.symlink(path.join(root, 'missing.cjs'), path.join(root, 'link.cjs'));
  try {
    for (const point of [{ path: '../missing.cjs', line: 1 }, { path: '.env', line: 1 }, { path: 'link.cjs', line: 1 }, { path: 'missing.cjs', line: 0 }, { path: 'missing.cjs', line: 1, condition: 'process.exit()' }]) {
      await fs.writeFile(metadata, JSON.stringify({ root: createHash('sha256').update(root).digest('hex'), breakpoints: [point] }));
      const run = await execution.start('Debug', task.id, { command: 'node', kind: 'debug', args: ['main.cjs'] });
      await assert.rejects(service.attach('Debug', task.id, run.id), { status: 400 });
      assert.equal(service.isBusy(), false);
      await execution.stop('Debug', task.id, run.id);
    }
  } finally { service.close(); await execution.stopAll(); }
}));

test('a naturally completed Inspector script exits and frees its execution slot without manual detach', () => withTmpWorkspace(async (ws) => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'Debug' });
  const task = await tasks.create('Debug', { title: 'Complete', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks, concurrent: 1 });
  const service = new DebuggerService(execution);
  const root = await execution.cwd('Debug', task.id);
  await fs.writeFile(path.join(root, 'main.cjs'), 'console.log("COMPLETED");\n');
  try {
    const run = await execution.start('Debug', task.id, { command: 'node', kind: 'debug', args: ['main.cjs'] });
    const session = await service.attach('Debug', task.id, run.id);
    await until(() => service.state('Debug', task.id, session.id).status === 'paused');
    await service.action('Debug', task.id, session.id, 'resume');
    await until(() => execution.output('Debug', task.id, run.id).status === 'exited');
    const result = execution.output('Debug', task.id, run.id);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.ok(result.output.some(item => item.text.includes('COMPLETED')));
    assert.equal(service.state('Debug', task.id, session.id).status, 'closed');
    assert.equal(service.isBusy(), false);
    assert.equal(execution.active(), 0);
    const next = await execution.start('Debug', task.id, { command: 'node', kind: 'debug', args: ['main.cjs'] });
    assert.equal(next.status, 'running');
  } finally { service.close(); await execution.stopAll(); }
}));

test('Inspector closes only when its default execution context is destroyed', async () => {
  const original = globalThis.WebSocket;
  let socket: FakeSocket | undefined;
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); socket = this; setImmediate(() => this.dispatchEvent(new Event('open'))); }
    emit(method: string, params: object) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params }) })); }
    send(data: string) {
      const message = JSON.parse(data) as { id: number; method: string };
      if (message.method === 'Runtime.enable') this.emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true } } });
      setImmediate(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result: {} }) })));
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const execution = { runDirectory() {}, async cwd() { return '/tmp'; }, output() { return { kind: 'debug', status: 'running', inspectorUrl: 'ws://127.0.0.1:1234/abcdef-1234' }; } };
  const service = new DebuggerService(execution as unknown as ExecutionService);
  try {
    const session = await service.attach('P', 'T', 'run');
    socket!.emit('Runtime.executionContextCreated', { context: { id: 2, auxData: { isDefault: false } } });
    socket!.emit('Runtime.executionContextDestroyed', { executionContextId: 2 });
    socket!.emit('Runtime.executionContextDestroyed', {});
    assert.equal(service.state('P', 'T', session.id).status, 'running');
    assert.equal(socket!.readyState, 1);
    socket!.emit('Runtime.executionContextDestroyed', { executionContextId: 1 });
    assert.equal(service.state('P', 'T', session.id).status, 'closed');
    assert.equal(socket!.readyState, 3);
  } finally { service.close(); globalThis.WebSocket = original; }
});
