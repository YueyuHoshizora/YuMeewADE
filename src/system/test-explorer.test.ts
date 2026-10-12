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
  const { tree } = parseNodeTap(`TAP version 13\n# Subtest: suite\n    # Subtest: passes\n    ok 1 - passes\n    # Subtest: omitted\n    ok 2 - omitted # SKIP\n    # Subtest: pending\n    not ok 3 - pending # TODO\n    # Subtest: fails\n    not ok 4 - fails\n      ---\n      location: '/project/sample.test.ts:12:3'\n      error: 'expected 1'\n      ...\nnot ok 1 - suite\n`, '/project');
  assert.equal(tree.length, 1); assert.equal(tree[0]!.status, 'failed');
  assert.deepEqual(tree[0]!.children.map(node => node.status), ['passed', 'skipped', 'todo', 'failed']);
  const fail = tree[0]!.children[3]!;
  assert.equal(fail.fullName, 'suite fails'); assert.equal(fail.file, 'sample.test.ts'); assert.equal(fail.line, 12); assert.match(fail.error!, /expected 1/u);
});

test('Node TAP names are unescaped, so a rerun selector matches the real case name', () => {
  // The reporter writes `#` as `\#` and `\` as `\\`.
  const { tree } = parseNodeTap('TAP version 13\n# Subtest: hash \\# name\nok 1 - hash \\# name\n# Subtest: back\\\\slash\nok 2 - back\\\\slash\n', '/project');
  assert.deepEqual(tree.map(node => [node.name, node.fullName, node.status]), [['hash # name', 'hash # name', 'passed'], ['back\\slash', 'back\\slash', 'passed']]);
});

test('lines inside a TAP YAML diagnostic block are never read as cases or results', () => {
  // An error message that itself contains TAP-looking lines, as Node prints it inside `---` … `...`.
  const tap = "TAP version 13\n# Subtest: real failure\nnot ok 1 - real failure\n  ---\n  location: '/project/a.test.mjs:2:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    first line\n    # Subtest: invented\n    ok 1 - invented\n  code: 'ERR_TEST_FAILURE'\n  ...\n1..1\n";
  const { tree } = parseNodeTap(tap, '/project');
  assert.deepEqual(tree.map(node => [node.name, node.status]), [['real failure', 'failed']]);
  assert.equal(tree[0]!.file, 'a.test.mjs'); assert.match(tree[0]!.error!, /ERR_TEST_FAILURE/u);
});

test('Node TAP keeps the first 2000 cases of a huge suite and leaves deeper or later subtests out cleanly', () => {
  const many = Array.from({ length: 2001 }, (_, i) => `# Subtest: case ${i}\nok ${i + 1} - case ${i}\n`).join('');
  const big = parseNodeTap(`TAP version 13\n${many}`, '/project');
  assert.equal(big.tree.length, 2000); assert.equal(big.truncated, true); assert.ok(big.tree.every(node => node.status === 'passed'));
  // A subtest with a 2,001-character name is left out with its children; its failure must not land on a neighbour.
  const long = parseNodeTap(`TAP version 13\n# Subtest: suite\n    # Subtest: ${'x'.repeat(2001)}\n        # Subtest: inner\n        not ok 1 - inner\n          error: 'hidden'\n    not ok 1 - long\n    # Subtest: kept\n    ok 2 - kept\nok 1 - suite\n`, '/project');
  assert.equal(long.truncated, true);
  assert.deepEqual(long.tree[0]!.children.map(node => [node.name, node.status, node.error]), [['kept', 'passed', undefined]]);
  assert.equal(long.tree[0]!.status, 'passed');
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

test('a Node suite whose TAP outgrows the shown output tail is still discovered in full', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: 'Tests', workspace: 'direct' });
  const root = projects.bodyPath(await projects.get('P'));
  // 1,000 passing cases print about 90 KiB, over the 64 KiB tail kept for display.
  await fs.writeFile(path.join(root, 'many.test.js'), `const {test}=require('node:test');for(let i=0;i<1000;i++)test('case '+i,()=>{});`);
  const verify = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
  const explorer = new TestExplorerService({ ws, projects, tasks, verify, beforeRun: async () => {}, isRunning: () => false });
  try {
    await explorer.save('P', task.id, { name: 'node', files: ['many.test.js'] }, (await explorer.state('P', task.id)).revision);
    const run = await explorer.run('P', task.id, 'node');
    assert.equal(run.result.truncated, true);
    assert.equal(run.tree.length, 1000); assert.equal(run.result.ok, true); assert.equal(run.treeTruncated, undefined);
    assert.ok(run.tree.every(node => node.status === 'passed'));
  } finally { await verify.stopAll(); }
}));

test('large failure reports retain a bounded, visibly partial history instead of losing the run', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: 'Tests', workspace: 'direct' });
  const root = projects.bodyPath(await projects.get('P'));
  await fs.writeFile(path.join(root, 'failures.test.js'), `const {test}=require('node:test');for(let i=0;i<1200;i++)test('failure '+i+' '+ 'x'.repeat(1900),()=>{throw new Error('failure detail');});`);
  const verify = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
  const options = { ws, projects, tasks, verify, beforeRun: async () => {}, isRunning: () => false };
  const explorer = new TestExplorerService(options);
  try {
    await explorer.save('P', task.id, { name: 'node', files: ['failures.test.js'] }, (await explorer.state('P', task.id)).revision);
    const run = await explorer.run('P', task.id, 'node');
    assert.equal(run.result.ok, false);
    assert.equal(run.treeTruncated, true);
    assert.equal(run.tree[0]!.name, 'failure 0 ' + 'x'.repeat(1900)); assert.equal(run.tree[0]!.status, 'failed');
    assert.match(run.tree[0]!.error!, /failure detail/u);
    const history = (await new TestExplorerService(options).state('P', task.id)).history;
    assert.deepEqual(history, [run]);
    assert.ok(Buffer.byteLength(JSON.stringify(history) + '\n') <= 4 * 1024 * 1024);
  } finally { await verify.stopAll(); }
}));

test('suite reruns execute only exact discovered descendants and reject ambiguous descendants', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' }); const task = await tasks.create('P', { title: 'Tests', workspace: 'direct' });
  const root = projects.bodyPath(await projects.get('P'));
  const file = path.join(root, 'suite.test.js');
  await fs.writeFile(file, `const {test,describe}=require('node:test');describe('suite',()=>{test('one',()=>{});describe('nested',()=>test('two.*',()=>{}));});test('suite unrelated',()=>{throw Error('must not rerun');});`);
  const verify = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
  const explorer = new TestExplorerService({ ws, projects, tasks, verify, beforeRun: async () => {}, isRunning: () => false });
  try {
    await explorer.save('P', task.id, { name: 'node', files: ['suite.test.js'] }, (await explorer.state('P', task.id)).revision);
    await explorer.run('P', task.id, 'node');
    const run = await explorer.run('P', task.id, 'node', 'suite');
    assert.equal(run.result.ok, true);
    assert.deepEqual(run.tree[0]!.children.map(node => node.status), ['passed', 'passed']);
    assert.ok(run.tree.every(node => node.fullName !== 'suite unrelated' || node.status === 'skipped'));
    await fs.writeFile(file, `const {test,describe}=require('node:test');describe('suite',()=>test('one',()=>{}));test('suite one',()=>{});`);
    await explorer.run('P', task.id, 'node');
    await assert.rejects(explorer.run('P', task.id, 'node', 'suite'), { status: 400 });
  } finally { await verify.stopAll(); }
}));

test('startup cancellation prevents test execution and releases the explorer reservation', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' }); const task = await tasks.create('P', { title: 'Tests', workspace: 'direct' });
  const root = projects.bodyPath(await projects.get('P'));
  await fs.writeFile(path.join(root, 'cancel.test.js'), `require('node:test').test('case',()=>require('node:fs').writeFileSync('launched','yes'));`);
  const verify = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const explorer = new TestExplorerService({ ws, projects, tasks, verify, beforeRun: async () => { entered.resolve(); await release.promise; }, isRunning: () => false });
  try {
    await explorer.save('P', task.id, { name: 'node', files: ['cancel.test.js'] }, (await explorer.state('P', task.id)).revision);
    const run = explorer.run('P', task.id, 'node');
    await entered.promise;
    assert.equal(explorer.isRunning('P', task.id), true); assert.equal(verify.isRunning('P', task.id), false);
    try { explorer.cancel('P', task.id); } catch (error) { release.resolve(); await run; throw error; }
    release.resolve(); await assert.rejects(run, { status: 409 });
    assert.equal(explorer.isBusy(), false); assert.equal(await fs.stat(path.join(root, 'launched')).catch(() => null), null);
    assert.equal((await explorer.state('P', task.id)).history.length, 0);
    assert.equal((await explorer.run('P', task.id, 'node')).tree[0]!.status, 'passed');
    assert.equal(await fs.readFile(path.join(root, 'launched'), 'utf8'), 'yes');
  } finally { release.resolve(); await verify.stopAll(); }
}));

test('failure locations retain spaces and quoted YAML scalars without escaping containment', () => {
  for (const location of ["'/project/space name.test.cjs:2:1'", '"/project/space name.test.cjs:2:1"', "'/project/quote'' name.test.cjs:2:1'"]) {
    const run = parseNodeTap(`# Subtest: failure\nnot ok 1 - failure\n  ---\n  location: ${location}\n  ...\n`, '/project');
    assert.equal(run.tree[0]!.file, location.includes("quote") ? "quote' name.test.cjs" : 'space name.test.cjs');
    assert.equal(run.tree[0]!.line, 2);
  }
  assert.equal(parseNodeTap("# Subtest: failure\nnot ok 1 - failure\n  ---\n  location: '/outside/space name.test.cjs:2:1'\n  ...\n", '/project').tree[0]!.file, undefined);
});

test('Node control characters and literal control escapes rerun exactly and collisions are refused', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' }); const task = await tasks.create('P', { title: 'Tests', workspace: 'direct' });
  const root = projects.bodyPath(await projects.get('P'));
  const names = ['line\nbreak', 'carriage\rreturn', 'tab\tname', 'literal\\nname', 'literal\\rname', 'literal\\tname'];
  const file = path.join(root, 'names.test.js');
  await fs.writeFile(file, `const {test}=require('node:test');for(const name of ${JSON.stringify(names)})test(name,()=>{});`);
  const verify = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false });
  const explorer = new TestExplorerService({ ws, projects, tasks, verify, beforeRun: async () => {}, isRunning: () => false });
  try {
    await explorer.save('P', task.id, { name: 'node', files: ['names.test.js'] }, (await explorer.state('P', task.id)).revision);
    const discovery = await explorer.run('P', task.id, 'node');
    assert.equal(discovery.tree.length, names.length);
    for (const node of discovery.tree) {
      const rerun = await explorer.run('P', task.id, 'node', node.fullName);
      assert.equal(rerun.result.ok, true, node.fullName);
      assert.deepEqual(rerun.tree.filter(item => item.status === 'passed').map(item => item.fullName), [node.fullName]);
    }
    await fs.writeFile(file, `const {test}=require('node:test');test('same\\nname',()=>{});test('same\\\\nname',()=>{});`);
    const collision = await explorer.run('P', task.id, 'node');
    assert.equal(collision.tree[0]!.fullName, collision.tree[1]!.fullName);
    await assert.rejects(explorer.run('P', task.id, 'node', collision.tree[0]!.fullName), { status: 400 });
  } finally { await verify.stopAll(); }
}));

test('cancellation forwards to a reserved VerifyService run before its child launches', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' }); const task = await tasks.create('P', { title: 'Tests', workspace: 'direct' });
  const root = projects.bodyPath(await projects.get('P'));
  await fs.writeFile(path.join(root, 'cancel.test.js'), `require('node:test').test('case',()=>require('node:fs').writeFileSync('launched','yes'));`);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const verify = new VerifyService({ ws, projects, tasks, config: parseConfig('', null), isRunning: () => false, beforeRun: async () => { entered.resolve(); await release.promise; } });
  const explorer = new TestExplorerService({ ws, projects, tasks, verify, beforeRun: async () => {}, isRunning: () => false });
  try {
    await explorer.save('P', task.id, { name: 'node', files: ['cancel.test.js'] }, (await explorer.state('P', task.id)).revision);
    const pending = explorer.run('P', task.id, 'node');
    await entered.promise; assert.equal(verify.isRunning('P', task.id), true);
    explorer.cancel('P', task.id); release.resolve();
    const run = await pending;
    assert.equal(run.result.ok, false); assert.equal(run.result.exitCode, null); assert.deepEqual(run.tree, []);
    assert.equal(await fs.stat(path.join(root, 'launched')).catch(() => null), null);
    assert.equal(explorer.isBusy(), false); assert.equal(verify.isBusy(), false);
  } finally { release.resolve(); await verify.stopAll(); }
}));
