import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from './projects.ts';

test('project creation stores named checks and verification policy with legacy autofix command fallback', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const project = await projects.create({ name: 'P', checks: [{ name: 'types', command: 'node check-types.js' }, { name: 'tests', command: 'node --test' }], requireVerification: true });
  assert.deepEqual(project.checks, [{ name: 'types', command: 'node check-types.js' }, { name: 'tests', command: 'node --test' }]);
  assert.equal(project.verify, 'node check-types.js');
  assert.equal(project.requireVerification, true);
  assert.equal((await projects.get('P')).requireVerification, true);
}));

test('named checks in old frontmatter provide verify fallback; legacy command updates clear old checks', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P', checks: [{ name: 'types', command: 'node types.js' }] });
  const file = ws.projectFile('P');
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace(/^verify:.*$/m, 'verify: ""'));
  assert.equal((await projects.get('P')).verify, 'node types.js');
  const updated = await projects.update('P', { verify: 'node legacy.js' });
  assert.equal(updated.verify, 'node legacy.js');
  assert.deepEqual(updated.checks, []);
  const named = await projects.update('P', { verify: 'node ignored-legacy.js', checks: [{ name: 'new', command: 'node new.js' }] });
  assert.equal(named.verify, 'node new.js');
  assert.deepEqual(named.checks, [{ name: 'new', command: 'node new.js' }]);
}));

test('invalid named checks and nonboolean policy are refused without changing existing project', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P' });
  const before = await fs.readFile(ws.projectFile('P'), 'utf8');
  await assert.rejects(projects.update('P', { checks: [{ name: 'same', command: 'node a.js' }, { name: 'same', command: 'node b.js' }] }));
  await assert.rejects(projects.update('P', { checks: [{ name: 'bad', command: 'node a.js\nnode b.js' }] }));
  await assert.rejects(projects.update('P', { requireVerification: 'yes' as unknown as boolean }));
  assert.equal(await fs.readFile(ws.projectFile('P'), 'utf8'), before);
  await assert.rejects(projects.create({ name: 'Bad', checks: [{ name: '', command: 'node check.js' }] }));
  await assert.rejects(fs.access(ws.projectDir('Bad')));
}));
