import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { VerifyService } from '../git/verify.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { parseConfig } from '../shared/config.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { parseNodeTap, TestExplorerService } from './test-explorer.ts';

test('Node TAP retains nested cases, skips, todo and failure source diagnostics', () => {
  const tree = parseNodeTap(`TAP version 13\n# Subtest: suite\n    # Subtest: passes\n    ok 1 - passes\n    # Subtest: omitted\n    ok 2 - omitted # SKIP\n    # Subtest: pending\n    not ok 3 - pending # TODO\n    # Subtest: fails\n    not ok 4 - fails\n      ---\n      location: '/project/sample.test.ts:12:3'\n      error: 'expected 1'\n      ...\nnot ok 1 - suite\n`, '/project');
  assert.equal(tree.length, 1); assert.equal(tree[0]!.status, 'failed');
  assert.deepEqual(tree[0]!.children.map(node => node.status), ['passed', 'skipped', 'todo', 'failed']);
  const fail = tree[0]!.children[3]!;
  assert.equal(fail.fullName, 'suite fails'); assert.equal(fail.file, 'sample.test.ts'); assert.equal(fail.line, 12); assert.match(fail.error!, /expected 1/u);
});

test('real Node suites discover failures, rerun a literal case and preserve history', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P', verify: 'node --test sample.test.js' });
  const task = await tasks.create('P', { title: 'Tests', workspace: 'direct' });
  const root = projects.bodyPath(await projects.get('P'));
  await fs.writeFile(path.join(root, 'sample.test.js'), `const {test,describe}=require('node:test');const assert=require('node:assert/strict');describe('suite',()=>{test('good [literal]',()=>assert.equal(1,1));test('bad',()=>assert.equal(1,2));test.skip('skip',()=>{});});`);
  const verify = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
  const options = { ws, projects, tasks, verify, beforeRun: async () => {}, isRunning: () => false };
  const explorer = new TestExplorerService(options);
  try {
    const initial = await explorer.state('P', task.id);
    await explorer.save('P', task.id, { name: 'node', files: ['sample.test.js'] }, initial.revision);
    await assert.rejects(explorer.save('P', task.id, { name: 'node', files: ['sample.test.js'] }, initial.revision), { status: 409 });
    const discovered = await explorer.run('P', task.id, 'node');
    assert.equal(discovered.result.ok, false); assert.equal(discovered.tree[0]!.children[1]!.status, 'failed');
    const rerun = await explorer.run('P', task.id, 'node', 'suite good [literal]');
    assert.equal(rerun.result.ok, true); assert.match(rerun.result.output, /good \[literal\]/u);
    assert.equal(await verify.status('P', task.id), null);
    const restored = new TestExplorerService(options);
    assert.equal((await restored.state('P', task.id)).history.length, 2);
    await assert.rejects(restored.save('P', task.id, { name: 'unsafe', files: ['../escape.js'] }, (await restored.state('P', task.id)).revision), { status: 400 });
    await assert.rejects(restored.run('P', task.id, 'node', 'name; touch hacked'), { status: 400 });
  } finally { await verify.stopAll(); }
}));
