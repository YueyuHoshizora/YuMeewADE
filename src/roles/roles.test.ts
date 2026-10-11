import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { parseRoles, resolveAvailableLaunch, resolveLaunch, writeRoles } from './roles.ts';
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
