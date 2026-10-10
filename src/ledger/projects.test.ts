import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AUTO_FIX_MAX, type ProjectPatch } from '../shared/types.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger, RULES_MAX } from './projects.ts';

test('verify command is trimmed, persisted, preserved and cleared', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  assert.equal((await projects.create({ name: 'P', verify: '  npm test  ' })).verify, 'npm test');
  assert.equal((await projects.update('P', { description: 'updated' })).verify, 'npm test');
  assert.equal((await projects.update('P', { verify: '  npm run typecheck  ' })).verify, 'npm run typecheck');
  assert.equal((await projects.update('P', { verify: '' })).verify, '');
  await fs.writeFile(ws.projectFile('P'), '---\nname: P\n---\n# Notes\n');
  assert.equal((await projects.get('P')).verify, '');
}));

test('verify command rejects invalid types, multiline, NUL and excess length', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P' });
  for (const verify of [123, null, 'echo a\necho b', 'echo a\recho b', 'a\0b', 'x'.repeat(501)]) {
    await assert.rejects(projects.update('P', { verify } as ProjectPatch), { status: 400 });
    await assert.rejects(projects.create({ name: 'Invalid', verify } as unknown as Parameters<ProjectLedger['create']>[0]), { status: 400 });
  }
  assert.equal((await projects.update('P', { verify: 'x'.repeat(500) })).verify.length, 500);
}));

test('autoFix persists as a bounded integer and defaults to 0', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  assert.equal((await projects.create({ name: 'P' })).autoFix, 0);
  assert.equal((await projects.update('P', { autoFix: AUTO_FIX_MAX })).autoFix, AUTO_FIX_MAX);
  assert.equal((await projects.update('P', { description: 'x' })).autoFix, AUTO_FIX_MAX);
  for (const autoFix of [-1, AUTO_FIX_MAX + 1, 1.5, '2', null]) await assert.rejects(projects.update('P', { autoFix } as unknown as ProjectPatch), { status: 400 });
  assert.equal((await projects.update('P', { autoFix: 0 })).autoFix, 0);
}));

test('project rules round-trip, can be cleared, and are bounded', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P' });
  assert.match(await projects.readRules('P'), /^# 共用規則/, 'new projects start with the template rules');
  await projects.writeRules('P', '# 規則\n- 先寫測試\n');
  assert.equal(await projects.readRules('P'), '# 規則\n- 先寫測試\n');
  assert.equal(await fs.readFile(ws.rulesFile('P'), 'utf8'), '# 規則\n- 先寫測試\n');
  await projects.writeRules('P', '');
  assert.equal(await projects.readRules('P'), '');
  await assert.rejects(projects.writeRules('P', 'x'.repeat(RULES_MAX + 1)), /過長/);
  await assert.rejects(projects.readRules('Missing'), /不存在/);
  await assert.rejects(projects.writeRules('Missing', 'x'), /不存在/);
  await assert.rejects(fs.access(path.join(ws.projectsDir, 'Missing')));
}));
