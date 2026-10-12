import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { loadRoles, parseRoles, resolveAvailableLaunch, resolveLaunch, writeRoles } from './roles.ts';
const initial = { ai: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
test('real defaults and roleless fallback', () => withTmpWorkspace(async ws => {
  const roles = parseRoles(await fs.readFile(ws.rolesFile, 'utf8'));
  assert.equal(roles.roles['規劃']?.main.model, 'claude-opus-5-5');
  assert.equal(roles.roles['最終確認']?.main.cli, '人');
  assert.deepEqual(resolveLaunch(roles, { role: '', cli: '', model: '', effort: '' }, {}, initial), { cli: initial.ai, model: initial.model, effort: initial.effort });
  assert.deepEqual(resolveLaunch(roles, { role: '實作', cli: 'claude', model: 'custom', effort: 'max' }, { model: 'override' }, initial), { cli: 'claude', model: 'override', effort: 'max' });
}));
test('switching AI does not inherit another provider effort; explicit CLI defaults clear saved choices', () => {
  const roles = parseRoles('roles:\n  build: { main: [codex, codex-model, high] }\n');
  const task = { role: 'build', cli: 'codex', model: 'codex-model', effort: 'high' };
  assert.deepEqual(resolveLaunch(roles, task, { cli: 'grok' }, initial), { cli: 'grok', model: '', effort: '' });
  assert.deepEqual(resolveLaunch(roles, { ...task, cli: 'grok', model: 'saved', effort: 'high' }, { model: '', effort: '' }, initial), { cli: 'grok', model: '', effort: '' });
});
test('role write round-trip retains header and unrelated sections', () => withTmpWorkspace(async ws => {
  await fs.writeFile(ws.rolesFile, '# header\npermissions:\n  auto: true\nroles:\n  old: { main: [人] }\nswitch:\n  auto: false\n');
  const inputs = [{ name: '設計:甲', job: '含 # 與冒號: 工作', main: { cli: 'claude', model: 'claude-opus-5-5', effort: 'max' }, backup: { cli: '人', model: '', effort: '' } }];
  const result = await writeRoles(ws.rolesFile, inputs);
  assert.deepEqual(result.roles[inputs[0]!.name], { main: inputs[0]!.main, backup: inputs[0]!.backup, job: inputs[0]!.job });
  assert.match(await fs.readFile(ws.rolesFile, 'utf8'), /^# header\npermissions:/u);
  assert.match(await fs.readFile(ws.rolesFile, 'utf8'), /switch:\n  auto: false/u);
  await assert.rejects(writeRoles(ws.rolesFile, [inputs[0]!, inputs[0]!]));
  await assert.rejects(writeRoles(ws.rolesFile, [{ name: 'x', job: '', main: { cli: 'codex', model: 'm', effort: 'ultra' } }]));
}));

test('role lookups ignore Object.prototype names and role input is bounded', () => withTmpWorkspace(async ws => {
  const roles = parseRoles('roles:\n  build: { main: [codex, m, high] }\n');
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) assert.equal(roles.roles[name], undefined);
  const role = (name: string, job = '', model = 'm') => ({ name, job, main: { cli: 'codex', model, effort: 'high' } });
  for (const name of ['__proto__', 'constructor', 'prototype']) await assert.rejects(writeRoles(ws.rolesFile, [role(name)]));
  await assert.rejects(writeRoles(ws.rolesFile, Array.from({ length: 51 }, (_, i) => role(`r${i}`))));
  await assert.rejects(writeRoles(ws.rolesFile, [role('r', 'x'.repeat(2001))]));
  await assert.rejects(writeRoles(ws.rolesFile, [role('r', '', 'm'.repeat(201))]));
  await assert.rejects(writeRoles(ws.rolesFile, [role('r', '', 'bad\u0001model')]));
  const ok = await writeRoles(ws.rolesFile, [...Array.from({ length: 49 }, (_, i) => role(`r${i}`)), role('last', 'x'.repeat(2000), 'm'.repeat(200))]);
  assert.equal(Object.keys(ok.roles).length, 50);
}));

test('role backup is selected only before execution when the primary is unavailable', async () => {
  const roles = parseRoles('roles:\n  build:\n    main: [claude, primary-model, max]\n    backup: [codex, backup-model, high]\n');
  const task = { role: 'build', cli: '', model: '', effort: '' };
  const available = async (cli: string) => cli === 'codex';
  assert.deepEqual(await resolveAvailableLaunch(roles, task, {}, initial, available), { cli: 'codex', model: 'backup-model', effort: 'high' });
  assert.deepEqual(await resolveAvailableLaunch(roles, task, {}, initial, async () => true), { cli: 'claude', model: 'primary-model', effort: 'max' });
  await assert.rejects(resolveAvailableLaunch(roles, task, { cli: 'claude' }, initial, available), { detail: 'cli_unavailable' });
  await assert.rejects(resolveAvailableLaunch(roles, { ...task, cli: 'claude' }, {}, initial, available), { detail: 'cli_unavailable' });
  await assert.rejects(resolveAvailableLaunch(roles, task, {}, initial, async () => false), { detail: 'cli_unavailable' });
  await assert.rejects(resolveAvailableLaunch(roles, task, {}, initial, async () => { throw new Error('availability failure'); }), /availability failure/u);
});

test('saving roles into a file that starts with a byte order mark replaces its roles block instead of adding a second one', () => withTmpWorkspace(async ws => {
  await fs.writeFile(ws.rolesFile, '\uFEFFroles:\n  "舊":\n    main: [codex, "m", high]\n    job: "old"\n');
  const saved = await writeRoles(ws.rolesFile, [{ name: '新', main: { cli: 'claude', model: '', effort: '' }, job: 'new' }]);
  assert.deepEqual(Object.keys(saved.roles), ['新']);
  assert.deepEqual(Object.keys(parseRoles(await fs.readFile(ws.rolesFile, 'utf8')).roles), ['新']);
}));

test('a hand-quoted roles key is replaced in place, and a save that cannot be read back leaves the file untouched', () => withTmpWorkspace(async ws => {
  for (const key of ['"roles"', "'roles'"]) {
    await fs.writeFile(ws.rolesFile, `# header\n${key}:\n  old: { main: [codex, old-model, high] }\n`);
    await writeRoles(ws.rolesFile, [{ name: 'new', main: { cli: 'codex', model: 'new-model', effort: 'high' }, job: '' }]);
    const text = await fs.readFile(ws.rolesFile, 'utf8');
    assert.ok(text.startsWith('# header\n'));
    assert.deepEqual(Object.keys((await loadRoles(ws.rolesFile)).roles), ['new']);
  }
  // A duplicate key elsewhere makes the result unreadable: refuse and keep the original bytes.
  const broken = 'roles:\n  a: { main: [codex, m, high] }\nother: 1\nother: 2\n';
  await fs.writeFile(ws.rolesFile, broken);
  await assert.rejects(writeRoles(ws.rolesFile, [{ name: 'b', main: { cli: 'codex', model: '', effort: '' }, job: '' }]), { detail: 'file_corrupt', field: 'roles.yaml' });
  assert.equal(await fs.readFile(ws.rolesFile, 'utf8'), broken);
}));

test('a hand-broken roles.yaml names the file to repair, a deleted one means no roles, and saving recreates it', () => withTmpWorkspace(async ws => {
  for (const broken of ['roles:\n  - name: [unclosed\n', 'roles:\n  "x":\n    main: [nosuchcli, "m", high]\n']) {
    await fs.writeFile(ws.rolesFile, broken);
    await assert.rejects(loadRoles(ws.rolesFile), { detail: 'file_corrupt', field: 'roles.yaml' });
  }
  await fs.rm(ws.rolesFile);
  assert.deepEqual(Object.keys((await loadRoles(ws.rolesFile)).roles), []);
  await writeRoles(ws.rolesFile, [{ name: 'dev', main: { cli: 'codex', model: '', effort: '' }, job: '' }]);
  assert.deepEqual(Object.keys((await loadRoles(ws.rolesFile)).roles), ['dev']);
}));
