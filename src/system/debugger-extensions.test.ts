import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { ExecutionService } from './commands.ts';
import { DebuggerService } from './debugger.ts';
import { debugFile, loadDebugSourceMap, originalLocation, generatedLocation } from './debug-source-maps.ts';
import { debugCondition, debugWatchPath } from '../shared/debug-expressions.ts';

// Real Inspector child-process events cannot be advanced by this test process's fake clock.
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(20); }
  assert.fail('debugger observable condition not reached');
}
test('bounded source maps resolve original/generated coordinates and reject remote, escape, secrets and symlinks', () => withTmpWorkspace(async (_ws, root) => {
  await fs.writeFile(path.join(root, 'source.ts'), 'const n: number = 2;');
  await fs.writeFile(path.join(root, 'output.js'), 'const n = 2;');
  const map = { version: 3, sources: ['source.ts'], sourcesContent: ['const n: number = 2;'], names: [], mappings: 'AAAA;AACA' };
  const save = async (value: unknown) => fs.writeFile(path.join(root, 'output.js.map'), JSON.stringify(value));
  await save(map);
  const loaded = await loadDebugSourceMap(root, path.join(root, 'output.js'), 'output.js.map');
  assert.deepEqual(loaded?.sources, ['source.ts']);
  assert.equal(originalLocation(loaded!, 2, 4)?.line, 2);
  assert.equal(generatedLocation(loaded!, 'source.ts', 2)?.generatedLine, 2);
  assert.equal(await loadDebugSourceMap(root, path.join(root, 'output.js'), 'https://example.com/map'), undefined);
  assert.equal(await loadDebugSourceMap(root, path.join(root, 'output.js'), '../outside.map'), undefined);
  for (const value of [{ ...map, sourceRoot: '../' }, { ...map, sourceRoot: 'https://example.com/' }, { ...map, sources: ['.env'] }, { ...map, sourcesContent: ['x'.repeat(262145)] }, { ...map, mappings: '!' }, { ...map, sections: [] }, { ...map, mappings: 'AAAA;'.repeat(65537) }]) { await save(value); assert.equal(await loadDebugSourceMap(root, path.join(root, 'output.js'), 'output.js.map'), undefined); }
  await fs.symlink(path.join(root, 'source.ts'), path.join(root, 'link.ts'));
  await save({ ...map, sources: ['link.ts'] });
  assert.equal(await loadDebugSourceMap(root, path.join(root, 'output.js'), 'output.js.map'), undefined);
  await assert.rejects(debugFile(root, 'link.ts'), { status: 400 });
  await save(map); await fs.symlink(path.join(root, 'output.js.map'), path.join(root, 'link.map'));
  assert.equal(await loadDebugSourceMap(root, path.join(root, 'output.js'), 'link.map'), undefined);
  const inline = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
  assert.deepEqual((await loadDebugSourceMap(root, path.join(root, 'output.js'), inline))?.sources, ['source.ts']);
}));

test('conditions and watches allow documented narrow grammar, never unrestricted evaluation', () => {
  assert.equal(debugCondition(' n === 2 '), 'n === 2');
  assert.equal(debugCondition('object.value !== "ready"'), 'object.value !== "ready"');
  assert.deepEqual(debugWatchPath('object.value'), ['object', 'value']);
  for (const value of ['process.exit()', 'a = 1', 'a.constructor === 1', 'a[0] === 1', 'a === 1; process.exit()', 'a === NaN', 'a === 1 || true']) assert.throws(() => debugCondition(value), { status: 400 });
  for (const value of ['a()', 'a[0]', '__proto__.x', 'a.constructor', 'a; x', 'a.'.repeat(140)]) assert.throws(() => debugWatchPath(value), { status: 400 });
});

test('real transpiled JS maps TS conditional breakpoint, stack and watches and restores per-task metadata on a new run', () => withTmpWorkspace(async (ws, dir) => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'Debug' });
  const task = await tasks.create('Debug', { title: 'Debug', workspace: 'direct' });
  const execution = new ExecutionService({ ws, projects, tasks });
  const metadata = path.join(dir, 'breakpoints.json');
  const debuggerService = new DebuggerService(execution, { metadataFile: async () => metadata });
  const root = await execution.cwd('Debug', task.id);
  const lines = ['function work() {', '  for (let n = 0; n < 4; n++) {', '    const object = { value: n };', '    console.log(object.value);', '  }', '}', 'setTimeout(work, 100);', 'setInterval(() => {}, 1000);'];
  await fs.writeFile(path.join(root, 'source.ts'), lines.join('\n').replace('work()', 'work(): void'));
  await fs.writeFile(path.join(root, 'output.cjs'), lines.join('\n') + '\n//# sourceMappingURL=output.cjs.map');
  await fs.writeFile(path.join(root, 'output.cjs.map'), JSON.stringify({ version: 3, sources: ['source.ts'], names: [], mappings: lines.map((_, i) => i ? 'AACA' : 'AAAA').join(';') }));
  try {
    const first = await execution.start('Debug', task.id, { command: 'node', kind: 'debug', args: ['output.cjs'] });
    const session = await debuggerService.attach('Debug', task.id, first.id);
    const state = () => debuggerService.state('Debug', task.id, session.id);
    await until(() => state().status === 'paused' && !!state().scripts.find(s => s.sources?.includes('source.ts')));
    await debuggerService.breakpoint('Debug', task.id, session.id, 'source.ts', 4, 'n === 2');
    await debuggerService.action('Debug', task.id, session.id, 'resume');
    await until(() => state().status === 'paused' && state().frames[0]?.location.source?.line === 4);
    assert.equal(state().frames[0]?.location.source?.path, 'source.ts');
    assert.equal((await debuggerService.watch('Debug', task.id, session.id, state().frames[0]!.id, 'n')).value, '2');
    assert.equal((await debuggerService.watch('Debug', task.id, session.id, state().frames[0]!.id, 'object.value')).value, '2');
    await assert.rejects(debuggerService.watch('Debug', task.id, session.id, 'foreign-frame', 'n'), { status: 400 });
    await assert.rejects(debuggerService.breakpoint('Debug', task.id, session.id, 'source.ts', 3, undefined, true, state().revision - 1), { status: 409 });
    assert.equal(JSON.parse(await fs.readFile(metadata, 'utf8')).breakpoints[0].condition, 'n === 2');
    await debuggerService.action('Debug', task.id, session.id, 'stepOver'); await until(() => state().status === 'paused');
    await execution.stop('Debug', task.id, first.id);
    const second = await execution.start('Debug', task.id, { command: 'node', kind: 'debug', args: ['output.cjs'] });
    const restored = await debuggerService.attach('Debug', task.id, second.id);
    const next = () => debuggerService.state('Debug', task.id, restored.id);
    await until(() => next().status === 'paused' && !!next().scripts.find(s => s.sources?.includes('source.ts')));
    assert.equal(next().breakpoints[0]?.path, 'source.ts');
    await debuggerService.action('Debug', task.id, restored.id, 'resume');
    await until(() => next().status === 'paused' && next().frames[0]?.location.source?.line === 4);
    assert.equal((await debuggerService.watch('Debug', task.id, restored.id, next().frames[0]!.id, 'n')).value, '2');
    await debuggerService.removeBreakpoint('Debug', task.id, restored.id, next().breakpoints[0]!.id);
    assert.deepEqual(JSON.parse(await fs.readFile(metadata, 'utf8')).breakpoints, []);
  } finally { debuggerService.close(); await execution.stopAll(); }
}));
