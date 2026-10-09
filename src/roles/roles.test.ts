import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AppError } from '../shared/errors.ts';
import { parseRoles, resolveLaunch } from './roles.ts';

const TEMPLATE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'templates', 'roles.yaml');

test('範本 roles.yaml 可解析', async () => {
  const roles = parseRoles(await fs.readFile(TEMPLATE, 'utf8'));
  assert.deepEqual(roles.models['claude'], ['opus', 'sonnet', 'haiku']);
  assert.deepEqual(roles.roles['實作']?.main, { cli: 'codex', model: 'default', effort: 'high' });
  assert.equal(roles.roles['最終確認']?.main.cli, '人');
  assert.equal(roles.roles['審查']?.job, '獨立審查（開發者仍須自行測試）');
});

test('resolveLaunch 優先序：覆寫 > 作業 > role', () => {
  const roles = parseRoles('roles:\n  實作: { main: [codex, default, high], job: x }\n  審查: { main: [claude, opus, xhigh] }\n  人工: { main: [人] }\n');
  const base = { role: '實作', cli: '', model: '', effort: '' };
  assert.deepEqual(resolveLaunch(roles, base, {}), { cli: 'codex', model: '', effort: 'high' });
  assert.deepEqual(resolveLaunch(roles, { ...base, model: 'gpt-6-sol', effort: 'low' }, {}), { cli: 'codex', model: 'gpt-6-sol', effort: 'low' });
  assert.deepEqual(resolveLaunch(roles, base, { cli: 'claude', model: 'haiku' }), { cli: 'claude', model: 'haiku', effort: 'high' });
  // 換 CLI 時不沿用 role 的模型（effort 與 CLI 無關，照用）
  assert.deepEqual(resolveLaunch(roles, { ...base, role: '審查' }, { cli: 'codex' }), { cli: 'codex', model: '', effort: 'xhigh' });
  assert.throws(() => resolveLaunch(roles, { ...base, role: '人工' }, {}), (e: unknown) => e instanceof AppError && e.code === 'bad_request');
  assert.throws(() => resolveLaunch(roles, { role: '', cli: '', model: '', effort: '' }, {}), AppError);
  assert.throws(() => resolveLaunch(roles, base, { effort: 'ultra' }), AppError);
});
