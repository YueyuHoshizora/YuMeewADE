import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { SettingsStore } from './settings.ts';

test('legacy defaults, literal profile paths, canonical duplicates, activation and removal', () => withTmpWorkspace(async (ws, dir) => {
  const store = new SettingsStore(ws, DEFAULT_CONFIG);
  await fs.writeFile(path.join(ws.internalDir, 'settings.json'), JSON.stringify({ hiddenModels: { codex: ['hidden'] } }));
  assert.deepEqual((await store.get()).accounts, {});
  assert.deepEqual((await store.get()).activeAccounts, {});
  const profile = path.join(dir, 'profile');
  const alias = path.join(dir, 'alias');
  await fs.mkdir(profile); await fs.symlink(profile, alias);
  const added = await store.addAccount('codex', ' Other ', alias);
  const account = added.accounts.codex![0]!;
  assert.equal(account.name, 'Other');
  assert.equal(account.configDir, alias);
  assert.match(account.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual((await new SettingsStore(ws, DEFAULT_CONFIG).get()).accounts, added.accounts);
  await assert.rejects(store.addAccount('codex', 'Duplicate', profile), { code: 'conflict' });
  await store.addAccount('claude', 'Same directory is allowed across AI', profile);
  await store.update({ activeAccounts: { codex: account.id } });
  assert.equal((await store.get()).activeAccounts.codex, account.id);
  await assert.rejects(store.update({ activeAccounts: { codex: 'missing' }, hiddenModels: { codex: ['changed'] } }), { code: 'not_found' });
  assert.deepEqual((await store.get()).hiddenModels.codex, ['hidden']);
  const removed = await store.removeAccount('codex', account.id);
  assert.equal(removed.activeAccounts.codex, 'default');
  assert.deepEqual(removed.accounts.codex, []);
  assert.ok((await fs.stat(profile)).isDirectory());
  await assert.rejects(store.update({ activeAccounts: { codex: account.id } }), { code: 'not_found' });
  await assert.rejects(store.removeAccount('codex', account.id), { code: 'not_found' });
}));

test('account validation and concurrent additions enforce limits atomically', () => withTmpWorkspace(async (ws, dir) => {
  const store = new SettingsStore(ws, DEFAULT_CONFIG);
  await assert.rejects(store.update({ accounts: {} }), { detail: 'field_type' });
  await assert.rejects(store.update({ activeAccounts: { mock: 'default' } }), { detail: 'cli_unsupported' });
  await assert.rejects(store.addAccount('mock', 'Name', dir), { detail: 'cli_unsupported' });
  await assert.rejects(store.addAccount('codex', '', dir), { detail: 'field_required' });
  await assert.rejects(store.addAccount('codex', 'x'.repeat(81), dir), { detail: 'field_too_long' });
  await assert.rejects(store.addAccount('codex', 'Name', 'relative'), { detail: 'root_not_absolute' });
  await assert.rejects(store.addAccount('codex', 'Name', '/'.repeat(4097)), { detail: 'field_too_long' });
  await assert.rejects(store.addAccount('codex', 'Name', path.join(dir, 'missing')), { detail: 'root_not_directory' });
  const file = path.join(dir, 'file'); await fs.writeFile(file, 'not a directory');
  await assert.rejects(store.addAccount('codex', 'Name', file), { detail: 'root_not_directory' });
  const dirs = Array.from({ length: 11 }, (_, i) => path.join(dir, String(i)));
  await Promise.all(dirs.map(folder => fs.mkdir(folder)));
  const results = await Promise.allSettled(dirs.map((folder, i) => store.addAccount('codex', String(i), folder)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 10);
  assert.equal((await store.get()).accounts.codex!.length, 10);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected'); assert.equal(rejected.reason.code, 'unavailable');
}));

test('concurrent removal and activation never leave a removed account active', () => withTmpWorkspace(async (ws, dir) => {
  const store = new SettingsStore(ws, DEFAULT_CONFIG);
  const account = (await store.addAccount('codex', 'Other', dir)).accounts.codex![0]!;
  await Promise.allSettled([store.removeAccount('codex', account.id), store.update({ activeAccounts: { codex: account.id } })]);
  const settings = await store.get();
  assert.deepEqual(settings.accounts.codex, []);
  assert.notEqual(settings.activeAccounts.codex, account.id);
}));

test('a missing registered directory does not prevent adding another profile', () => withTmpWorkspace(async (ws, dir) => {
  const store = new SettingsStore(ws, DEFAULT_CONFIG);
  const original = path.join(dir, 'original');
  const next = path.join(dir, 'next');
  await fs.mkdir(original); await fs.mkdir(next);
  await store.addAccount('claude', 'Original', original);
  await fs.rmdir(original);
  const settings = await store.addAccount('claude', 'Next', next);
  assert.deepEqual(settings.accounts.claude!.map(account => account.configDir), [original, next]);
}));
