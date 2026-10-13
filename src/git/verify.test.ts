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
import { gitOk } from './git.ts';

async function setup(ws: Workspace, verify: string, limits = '', isRunning = () => false) {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P', verify });
  const task = await tasks.create('P', { title: 'Verify', workspace: 'direct' });
  const service = new VerifyService({ ws, projects, tasks, config: parseConfig(limits, null), isRunning });
  return { service, projects, tasks, task };
}

test('cancelling before spawn prevents commands from running and cannot leave a passing result', () => withTmpWorkspace(async ws => {
  const { projects, tasks, task, service: unused } = await setup(ws, nodeCommand("require('node:fs').writeFileSync('should-not-exist','ran')"));
  await unused.stopAll();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const service = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false, beforeRun: async () => { entered.resolve(); await release.promise; } });
  try {
    const pending = service.run('P', task.id);
    await entered.promise; service.cancel('P', task.id); release.resolve();
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.timedOut, false);
    await assert.rejects(fs.access(path.join(ws.projectDir('P'), 'should-not-exist')), { code: 'ENOENT' });
    assert.notEqual((await service.status('P', task.id))?.ok, true);
  } finally { release.resolve(); await service.stopAll(); }
}));

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

test('ledger bookkeeping under the project .ai keeps a direct task green; source and a main folder .ai still invalidate', () => withTmpWorkspace(async ws => {
  const { service, projects, task } = await setup(ws, nodeCommand('0'));
  try {
    assert.equal((await service.run('P', task.id)).ok, true);
    // Chat, task and workflow files live in the ledger folder, which is also the direct task's working root.
    await fs.mkdir(path.join(ws.projectDir('P'), '.ai', 'chat'), { recursive: true });
    await fs.appendFile(path.join(ws.projectDir('P'), '.ai', 'chat', `${task.id}.jsonl`), '{"role":"user"}\n');
    await fs.mkdir(path.join(ws.projectDir('P'), '.ai', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(ws.projectDir('P'), '.ai', 'workflows', `${task.id}.json`), '{}');
    assert.equal((await service.status('P', task.id))?.ok, true);
    await fs.writeFile(path.join(ws.projectDir('P'), 'source.ts'), 'changed');
    assert.equal(await service.status('P', task.id), null);
    // An external main folder's own .ai directory is project content, not ledger bookkeeping.
    const body = path.join(ws.root, 'external-body');
    await fs.mkdir(path.join(body, '.ai'), { recursive: true });
    await gitOk(body, ['init', '-q']);
    await projects.update('P', { body });
    assert.equal((await service.run('P', task.id)).ok, true);
    await fs.writeFile(path.join(body, '.ai', 'input.json'), '{}');
    assert.equal(await service.status('P', task.id), null);
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

test('verify decodes split UTF-8 independently before combining stdout and stderr', () => withTmpWorkspace(async ws => {
  // Real child/OS pipe delivery must split the writes across separate reads; parent fake timers cannot drive those pipes.
  const { service, task } = await setup(ws, nodeCommand("process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stderr.write('ERR'),150);setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),300)"));
  try {
    const result = await service.run('P', task.id);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, false);
    assert.equal(result.output, 'ERR中');
    assert.equal(result.steps?.[0]?.output, 'ERR中');
    const framework = await service.runFrameworkTests('P', task.id, process.execPath, ['-e', "process.stderr.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.write('OUT'),150);setTimeout(()=>process.stderr.write(Buffer.from([0xb8,0xad])),300)"]);
    assert.equal(framework.output, 'OUT中');
    assert.equal(framework.truncated, false);
  } finally { await service.stopAll(); }
}));

test('verify omits a partial UTF-8 character at the combined byte-tail boundary', () => withTmpWorkspace(async ws => {
  const { service, task } = await setup(ws, nodeCommand("process.stdout.write('中TAIL')"), 'limits:\n  verifyOutputBytes: 6\n');
  try {
    const result = await service.run('P', task.id);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.output, 'TAIL');
    assert.ok(Buffer.byteLength(result.output) <= 6);
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
    assert.equal(await service.status('P', task.id), null);
    await service.run('P', task.id);
    assert.equal((await service.status('P', task.id))?.ok, true);
    await projects.update('P', { verify: nodeCommand('process.exit(3)') });
    await service.run('P', task.id);
    const failed = await service.status('P', task.id);
    assert.equal(failed?.ok, false); assert.equal(failed?.exitCode, 3);
    assert.equal(await service.status('P', 'other-task'), null);
    service.invalidate('P', task.id);
    assert.equal(await service.status('P', task.id), null);
  } finally { await service.stopAll(); }
}));

test('external tracked, untracked and ignored edits and command changes invalidate passing verification', () => withTmpWorkspace(async ws => {
  const { service, projects, task } = await setup(ws, nodeCommand('process.exit(0)'));
  const project = await projects.get('P');
  const dir = projects.bodyPath(project);
  try {
    await fs.writeFile(path.join(dir, 'input.txt'), 'before');
    await gitOk(dir, ['add', 'input.txt']);
    await gitOk(dir, ['commit', '-m', 'verification input']);
    await service.run('P', task.id);
    assert.equal((await service.status('P', task.id))?.ok, true);
    await fs.writeFile(path.join(dir, 'input.txt'), 'after');
    assert.equal(await service.status('P', task.id), null);
    await service.run('P', task.id);
    await fs.writeFile(path.join(dir, 'untracked.txt'), 'new');
    assert.equal(await service.status('P', task.id), null);
    await service.run('P', task.id);
    await fs.writeFile(path.join(dir, '.env'), 'CANARY=changed');
    assert.equal(await service.status('P', task.id), null);
    await service.run('P', task.id);
    await gitOk(dir, ['commit', '--allow-empty', '-m', 'new HEAD']);
    assert.equal(await service.status('P', task.id), null);
    await service.run('P', task.id);
    await projects.update('P', { verify: nodeCommand('process.exit(1)') });
    assert.equal(await service.status('P', task.id), null);
  } finally { await service.stopAll(); }
}));

test('editing during verification cannot produce a green aggregate', () => withTmpWorkspace(async ws => {
  const { service, projects, task } = await setup(ws, nodeCommand('require(\'node:fs\').writeFileSync(\'ready\',\'yes\')'));
  try {
    const result = await service.run('P', task.id);
    assert.equal(result.ok, false);
    assert.equal(result.drifted, true);
    assert.equal(await service.status('P', task.id), null);
    assert.equal(await fs.readFile(path.join(projects.bodyPath(await projects.get('P')), 'ready'), 'utf8'), 'yes');
  } finally { await service.stopAll(); }
}));

test('named checks retain each result and one failure fails the aggregate and merge gate', () => withTmpWorkspace(async ws => {
  const { service, projects, task } = await setup(ws, nodeCommand('process.exit(0)'));
  try {
    await projects.update('P', { requireVerification: true, checks: [
      { name: 'types', command: nodeCommand('process.exit(0)') },
      { name: 'tests', command: nodeCommand('process.exit(4)') },
    ] });
    await assert.rejects(service.requireCurrentPass('P', task.id), { status: 409 });
    const failed = await service.run('P', task.id);
    assert.equal(failed.ok, false); assert.equal(failed.exitCode, 4);
    assert.deepEqual(failed.steps?.map(step => [step.name, step.ok]), [['types', true], ['tests', false]]);
    await assert.rejects(service.requireCurrentPass('P', task.id), { status: 409 });
    await projects.update('P', { checks: [{ name: 'types', command: nodeCommand('process.exit(0)') }] });
    await service.run('P', task.id);
    await service.requireCurrentPass('P', task.id);
    await fs.writeFile(path.join(projects.bodyPath(await projects.get('P')), 'external'), 'changed');
    await assert.rejects(service.requireCurrentPass('P', task.id), { status: 409 });
    await projects.update('P', { requireVerification: false });
    await service.requireCurrentPass('P', task.id);
  } finally { await service.stopAll(); }
}));

test('a transient input edit restored to identical bytes still invalidates verification', () => withTmpWorkspace(async ws => {
  const { service, projects, task } = await setup(ws, nodeCommand("const fs=require('node:fs');fs.writeFileSync('transient.txt','changed');fs.writeFileSync('transient.txt','original')"));
  const file = path.join(projects.bodyPath(await projects.get('P')), 'transient.txt');
  await fs.writeFile(file, 'original');
  try {
    const result = await service.run('P', task.id);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    assert.equal(result.ok, false); assert.equal(result.drifted, true);
    assert.equal(await service.status('P', task.id), null);
  } finally { await service.stopAll(); }
}));

test('verification history survives restart but never verifies changed content', () => withTmpWorkspace(async ws => {
  const { service, projects, tasks, task } = await setup(ws, nodeCommand('process.exit(0)'));
  await projects.update('P', { requireVerification: true });
  await service.run('P', task.id);
  await service.stopAll();
  const restored = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
  try {
    assert.equal((await restored.history('P', task.id)).length, 1);
    await restored.requireCurrentPass('P', task.id);
    await fs.writeFile(path.join(projects.bodyPath(await projects.get('P')), '.ignored-input'), 'change');
    await assert.rejects(restored.requireCurrentPass('P', task.id), { status: 409 });
    assert.equal((await restored.history('P', task.id)).length, 1);
  } finally { await restored.stopAll(); }
}));

test('restored merge gate rejects a pass after the effective inherited environment changes', () => withTmpWorkspace(async ws => {
  const previous = process.env['LANG'];
  process.env['LANG'] = 'yume-verify-passing-locale';
  const { service, projects, tasks, task } = await setup(ws, nodeCommand("process.exit(process.env.LANG === 'yume-verify-passing-locale' ? 0 : 7)"));
  let restored: VerifyService | undefined;
  try {
    await projects.update('P', { requireVerification: true });
    assert.equal((await service.run('P', task.id)).ok, true);
    await service.stopAll();
    restored = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
    await restored.requireCurrentPass('P', task.id);
    const history = await restored.history('P', task.id);
    assert.equal(history[0]?.configuration.includes('"LANG"'), false);
    process.env['LANG'] = 'yume-verify-failing-locale';
    assert.equal(await restored.status('P', task.id), null);
    await assert.rejects(restored.requireCurrentPass('P', task.id), { status: 409, detail: 'verification_required' });
    const result = await restored.run('P', task.id);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 7);
    assert.equal((await restored.history('P', task.id))[1]?.configuration.includes('yume-verify-failing-locale'), false);
  } finally {
    await service.stopAll();
    await restored?.stopAll();
    if (previous === undefined) delete process.env['LANG'];
    else process.env['LANG'] = previous;
  }
}));

test('a pass recorded with an environment passthrough no longer counts after that setting or its value changes', () => withTmpWorkspace(async ws => {
  process.env['YUME_VERIFY_FLAG'] = 'yes';
  const { service, projects, tasks, task } = await setup(ws, nodeCommand("process.exit(process.env.YUME_VERIFY_FLAG === 'yes' ? 0 : 9)"), 'cli:\n  envPassthrough: [YUME_VERIFY_FLAG]\n');
  try {
    await projects.update('P', { requireVerification: true });
    assert.equal((await service.run('P', task.id)).ok, true);
    await service.requireCurrentPass('P', task.id);
    await service.stopAll();
    // Restarted without the passthrough: the check would now fail, so the old pass must not open the merge gate.
    const without = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
    try { await assert.rejects(without.requireCurrentPass('P', task.id), { status: 409 }); } finally { await without.stopAll(); }
    process.env['YUME_VERIFY_FLAG'] = 'no';
    const changed = new VerifyService({ ws, projects, tasks, config: parseConfig('cli:\n  envPassthrough: [YUME_VERIFY_FLAG]\n', null), isRunning: () => false });
    try { await assert.rejects(changed.requireCurrentPass('P', task.id), { status: 409 }); } finally { await changed.stopAll(); }
  } finally { delete process.env['YUME_VERIFY_FLAG']; }
}));
