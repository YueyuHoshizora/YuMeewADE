import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameworkCommand, parseFrameworkReport } from './test-frameworks.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withTmpWorkspace } from '../testing/tmp.ts';

test('Jest and Vitest JSON preserve statuses and failure locations', () => {
  const report = JSON.stringify({ testResults: [{ name: '/repo/spec.test.ts', assertionResults: [
    { title: 'passes', fullName: 'suite passes', status: 'passed' },
    { title: 'fails', fullName: 'suite fails', status: 'failed', failureMessages: ['at /repo/spec.test.ts:14:2'] },
    { title: 'skipped', fullName: 'suite skipped', status: 'pending' },
    { title: 'later', fullName: 'suite later', status: 'todo' },
  ] }] });
  for (const framework of ['jest', 'vitest']) {
    const tree = parseFrameworkReport(framework, report, '/repo');
    assert.deepEqual(tree.map(node => node.status), ['passed', 'failed', 'skipped', 'todo']);
    assert.equal(tree[1]!.file, 'spec.test.ts'); assert.equal(tree[1]!.line, 14);
  }
});

test('pytest legacy JUnit gives exact parametrized node ids without parsing source', async () => {
  const tree = parseFrameworkReport('pytest', '<testsuites><testsuite><testcase classname="tests.test_api.TestAPI" name="test_case[a&amp;b]" file="tests/test_api.py" line="8"/><testcase classname="tests.test_api" name="test_bad" file="tests/test_api.py" line="20"><failure message="bad">assert 1 == 2</failure></testcase><testcase classname="tests.test_api" name="test_skip" file="tests/test_api.py"><skipped/></testcase></testsuite></testsuites>', '/repo');
  assert.deepEqual(tree.map(node => node.status), ['passed', 'failed', 'skipped']);
  assert.equal(tree[0]!.selector, './tests/test_api.py::TestAPI::test_case[a&b]');
  const command = await frameworkCommand('/repo', { name: 'py', framework: 'pytest', files: ['tests/test_api.py'], config: 'pytest.ini' }, '/tmp/report', tree[0]);
  assert.equal(command.command, 'python3'); assert.equal(command.args.at(-1), tree[0]!.selector);
  assert.equal(tree[1]!.line, 21);
  assert.throws(() => parseFrameworkReport('pytest', '<!DOCTYPE x><testsuites/>', '/repo'));
});

test('Go JSON events retain package-qualified subtests and skips', () => {
  const report = [
    { Action: 'run', Package: 'example.local/mod', Test: 'TestGroup' },
    { Action: 'run', Package: 'example.local/mod', Test: 'TestGroup/fails' },
    { Action: 'output', Package: 'example.local/mod', Test: 'TestGroup/fails', Output: '  sample_test.go:12: expected value\n' },
    { Action: 'fail', Package: 'example.local/mod', Test: 'TestGroup/fails' },
    { Action: 'fail', Package: 'example.local/mod', Test: 'TestGroup' },
    { Action: 'skip', Package: 'example.local/mod', Test: 'TestSkipped' },
  ].map(event => JSON.stringify(event)).join('\n');
  const tree = parseFrameworkReport('go', report, '/repo');
  assert.equal(tree[0]!.children[0]!.selector, 'example.local/mod::TestGroup/fails');
  assert.equal(tree[0]!.children[0]!.line, 12);
  assert.equal(tree[1]!.status, 'skipped');
});

test('argv treats Node test names literally and unavailable JS tools fail clearly', async () => {
  const selected = { id: '1', name: 'literal.*; touch bad', fullName: 'literal.*; touch bad', status: 'passed' as const, children: [] };
  const command = await frameworkCommand('/repo', { name: 'node', framework: 'node', files: ['sample.test.ts'] }, '/tmp/report', selected);
  assert(command.args.includes('--test-name-pattern=^literal\\.\\*; touch bad$'));
  await assert.rejects(frameworkCommand('/missing-framework-root', { name: 'vitest', framework: 'vitest', files: ['x.test.ts'] }, '/tmp/report'), { status: 503 });
});

test('nested JS report cases have unique ids and retain runner-specific selectors', () => {
  const report = JSON.stringify({ testResults: [{ name: '/repo/spec.test.ts', assertionResults: [
    { title: 'first', fullName: 'outer inner first', ancestorTitles: ['outer', 'inner'], status: 'passed' },
    { title: 'second', fullName: 'outer inner second', ancestorTitles: ['outer', 'inner'], status: 'failed' },
    { title: 'third', fullName: 'outer third', ancestorTitles: ['outer'], status: 'pending' },
  ] }] });
  for (const framework of ['jest', 'vitest']) {
    const tree = parseFrameworkReport(framework, report, '/repo');
    const cases = [...tree[0]!.children[0]!.children, tree[0]!.children[1]!];
    assert.equal(new Set(cases.map(node => node.id)).size, 3);
    assert.equal(tree[0]!.fullName, 'outer');
    if (framework === 'vitest') {
      assert.equal(tree[0]!.selector, 'outer');
      assert.equal(cases[0]!.selector, 'outer > inner > first');
    }
  }
});

test('Vitest 5 uses exact runner names while older versions retain JSON-name matching', () => withTmpWorkspace(async (_ws, dir) => {
  const root = await fs.realpath(dir);
  const installed = path.join(root, 'node_modules', 'vitest');
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, 'vitest.mjs'), '');
  const report = JSON.stringify({ testResults: [{ name: path.join(root, 'spec.test.ts'), assertionResults: [
    { title: 'case.*', fullName: 'suite+ case.*', ancestorTitles: ['suite+'], status: 'passed' },
  ] }] });
  const tree = parseFrameworkReport('vitest', report, root);
  const config = { name: 'vitest', framework: 'vitest' as const, files: ['spec.test.ts'] };
  await fs.writeFile(path.join(installed, 'package.json'), '{"version":"5.0.1"}');
  let command = await frameworkCommand(root, config, '/tmp/report', tree[0]!.children[0]);
  assert(command.args.includes('^suite\\+ > case\\.\\*$'));
  command = await frameworkCommand(root, config, '/tmp/report', tree[0]);
  assert(command.args.includes('^suite\\+(?: > |$)'));
  await fs.writeFile(path.join(installed, 'package.json'), '{"version":"4.1.0"}');
  command = await frameworkCommand(root, config, '/tmp/report', tree[0]!.children[0]);
  assert(command.args.includes('^suite\\+ case\\.\\*$'));
  command = await frameworkCommand(root, config, '/tmp/report', tree[0]);
  assert(command.args.includes('^suite\\+(?: |$)'));
}));
