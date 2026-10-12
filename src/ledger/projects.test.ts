import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AUTO_FIX_MAX, type ProjectPatch } from '../shared/types.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { NOTES_MAX, ProjectLedger, RULES_MAX } from './projects.ts';

test('create reuses an empty leftover folder but never touches one with data', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await fs.mkdir(ws.projectDir('Empty'), { recursive: true });
  assert.equal((await projects.create({ name: 'Empty' })).name, 'Empty');
  await fs.mkdir(ws.projectDir('Busy'), { recursive: true });
  await fs.writeFile(path.join(ws.projectDir('Busy'), 'keep.txt'), 'data');
  await assert.rejects(projects.create({ name: 'Busy' }), (error: unknown) => (error as { detail?: string }).detail === 'project_exists');
  assert.equal(await fs.readFile(path.join(ws.projectDir('Busy'), 'keep.txt'), 'utf8'), 'data');
}));

test('two concurrent moves that only form a loop together cannot both succeed', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  for (const name of ['A', 'B']) await projects.create({ name });
  const results = await Promise.allSettled([projects.update('A', { parent: 'B' }), projects.update('B', { parent: 'A' })]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const list = await projects.list();
  assert.ok(list.some(project => !project.parent), 'at least one project stays a sidebar root');
  await assert.rejects(projects.update('A', { parent: 'A' }), { status: 400, field: 'parent' });
}));

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

test('project rules round-trip, can be cleared, are bounded and refuse rules changed since they were read', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P' });
  const template = await projects.readRules('P');
  assert.match(template, /^# 共用規則/, 'new projects start with the template rules');
  await projects.writeRules('P', '# 規則\n- 先寫測試\n', template);
  assert.equal(await projects.readRules('P'), '# 規則\n- 先寫測試\n');
  assert.equal(await fs.readFile(ws.rulesFile('P'), 'utf8'), '# 規則\n- 先寫測試\n');
  // Another window (or a hand/AI edit) changed the file after this editor read it: keep that change.
  await assert.rejects(projects.writeRules('P', 'stale editor', template), { detail: 'rules_changed' });
  assert.equal(await projects.readRules('P'), '# 規則\n- 先寫測試\n');
  await projects.writeRules('P', '', '# 規則\n- 先寫測試\n');
  assert.equal(await projects.readRules('P'), '');
  await fs.rm(ws.rulesFile('P'));
  await projects.writeRules('P', 'from scratch', '');
  assert.equal(await projects.readRules('P'), 'from scratch');
  await assert.rejects(projects.writeRules('P', 'x'.repeat(RULES_MAX + 1), 'from scratch'), /過長/);
  await assert.rejects(projects.readRules('Missing'), /不存在/);
  await assert.rejects(projects.writeRules('Missing', 'x', ''), /不存在/);
  await assert.rejects(fs.access(path.join(ws.projectsDir, 'Missing')));
}));

test('project notes replace only the body, keep the frontmatter and refuse a body changed since it was read', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P', description: '說明' });
  const original = await projects.readNotes('P');
  const saved = await projects.writeNotes('P', '# 備註\n第一行\n- 第二行', original);
  assert.equal(saved.name, 'P'); assert.equal(saved.description, '說明'); assert.equal(saved.status, '進行中');
  assert.equal(saved.notes, '第一行\n- 第二行');
  assert.equal(await projects.readNotes('P'), '# 備註\n第一行\n- 第二行\n');
  // A stale editor (it still holds the original body) must not overwrite the newer notes.
  await assert.rejects(projects.writeNotes('P', 'stale', original), /備註已在別處修改/);
  await assert.rejects(projects.writeNotes('P', 'x'.repeat(NOTES_MAX + 1), await projects.readNotes('P')), /過長/);
  assert.equal((await projects.get('P')).notes, '第一行\n- 第二行');
  // Windows line endings are stored as the LF text read back, and the same CRLF text is still the caller's own version.
  const crlf = 'first\r\nsecond\r\n';
  await projects.writeNotes('P', crlf, await projects.readNotes('P'));
  assert.equal(await projects.readNotes('P'), 'first\nsecond\n');
  await projects.writeNotes('P', 'next\n', crlf);
  assert.equal(await projects.readNotes('P'), 'next\n');
}));

test('project update with expected fields refuses a value changed since the editor read it', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P', description: 'old', checks: [{ name: 'unit', command: 'npm test' }] });
  const seen = await projects.get('P');
  // Window A saves new checks; window B still shows the old ones.
  await projects.update('P', { checks: [{ name: 'unit', command: 'npm run test:all' }] }, { checks: seen.checks, verify: seen.verify, verificationInputs: seen.verificationInputs ?? null });
  await assert.rejects(projects.update('P', { checks: [{ name: 'lint', command: 'npm run lint' }] }, { checks: seen.checks, verify: seen.verify }), { detail: 'project_changed' });
  assert.deepEqual((await projects.get('P')).checks, [{ name: 'unit', command: 'npm run test:all' }]);
  // Fields not listed in expected may change freely; a matching expectation saves.
  await projects.update('P', { description: 'new' }, { description: 'old' });
  // An API caller listing the same check with its keys in another order is not a conflict.
  await projects.update('P', { description: 'newer' }, { description: 'new', checks: [{ command: 'npm run test:all', name: 'unit' }] });
  await assert.rejects(projects.update('P', { description: 'stale' }, { description: 'old' }), { detail: 'project_changed' });
  assert.equal((await projects.get('P')).description, 'newer');
}));
