import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
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

test('failed credential import leaves registered accounts and the active selection unchanged', () => withTmpWorkspace(async (ws, dir) => {
  const store = new SettingsStore(ws, DEFAULT_CONFIG);
  const existing = (await store.addAccount('codex', 'Existing', dir)).accounts.codex![0]!;
  await store.update({ activeAccounts: { codex: existing.id } });
  const file = path.join(ws.internalDir, 'settings.json');
  const before = await fs.readFile(file, 'utf8');
  const profile = path.join(dir, 'not-signed-in');
  await fs.mkdir(profile);
  const importing = new SettingsStore(ws, DEFAULT_CONFIG, async () => {
    throw new AppError('unavailable', 'credentials_unavailable');
  });
  await assert.rejects(importing.addAccount('codex', 'Unavailable', profile), { detail: 'credentials_unavailable' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await importing.get()).activeAccounts.codex, existing.id);
}));

test('OAuth add creates the folder, logs in before importing, and cleans up when login fails', () => withTmpWorkspace(async (ws, dir) => {
  const order: string[] = [];
  let failLogin = false;
  const store = new SettingsStore(ws, DEFAULT_CONFIG, async () => { order.push('import'); }, async (_ai, directory) => {
    order.push('login');
    assert.ok((await fs.stat(directory)).isDirectory());
    if (failLogin) throw new AppError('unavailable', 'login_failed');
  });
  const fresh = path.join(dir, 'a', 'fresh');
  const added = await store.addAccount('grok', 'New', fresh, true);
  assert.deepEqual(order, ['login', 'import']);
  assert.equal(added.accounts.grok![0]!.configDir, fresh);
  await assert.rejects(store.addAccount('grok', 'Again', fresh, true), { code: 'conflict' });
  assert.deepEqual(order, ['login', 'import']); // duplicate is rejected before the browser opens
  failLogin = true;
  const failed = path.join(dir, 'b', 'failed');
  await assert.rejects(store.addAccount('grok', 'Bad', failed, true), { detail: 'login_failed' });
  await assert.rejects(fs.stat(failed), { code: 'ENOENT' });
  assert.equal((await store.get()).accounts.grok!.length, 1);
  await assert.rejects(new SettingsStore(ws, DEFAULT_CONFIG).addAccount('grok', 'x', path.join(dir, 'c'), true), { detail: 'credentials_unavailable' });
}));

test('OAuth add without a folder logs in inside an app-generated isolated directory', () => withTmpWorkspace(async (ws, dir) => {
  let logged = '';
  const store = new SettingsStore(ws, DEFAULT_CONFIG, undefined, async (_ai, directory) => { logged = directory; }, ai => path.join(dir, 'profiles', ai, `n${Math.random()}`));
  const first = (await store.addAccount('codex', 'One', undefined, true)).accounts.codex![0]!;
  assert.equal(first.configDir, logged);
  assert.ok(first.configDir.startsWith(path.join(dir, 'profiles', 'codex')));
  const second = (await store.addAccount('codex', 'Two', undefined, true)).accounts.codex![1]!;
  assert.notEqual(second.configDir, first.configDir);
  await assert.rejects(store.addAccount('codex', 'No login', undefined, false), { detail: 'field_type' });
}));

test('first account is selected per service; later additions preserve the selection', () => withTmpWorkspace(async (ws, dir) => {
  const slots: Record<string, string | undefined> = {};
  const store = new SettingsStore(ws, DEFAULT_CONFIG, undefined, undefined, undefined, async (ai, directory) => { slots[ai] = directory; });
  for (const ai of ['claude', 'codex', 'grok', 'gemini']) {
    const firstDir = path.join(dir, ai, 'first');
    const secondDir = path.join(dir, ai, 'second');
    await fs.mkdir(firstDir, { recursive: true });
    await fs.mkdir(secondDir);
    const first = await store.addAccount(ai, 'First', firstDir);
    const selected = first.accounts[ai]![0]!.id;
    assert.equal(first.activeAccounts[ai], selected);
    assert.equal(slots[ai], firstDir);
    const second = await store.addAccount(ai, 'Second', secondDir);
    assert.equal(second.activeAccounts[ai], selected);
    assert.equal(slots[ai], firstDir);
    assert.equal((await new SettingsStore(ws, DEFAULT_CONFIG).get()).activeAccounts[ai], selected);
  }
}));

test('failed activation of the first account never saves a selected but unusable account', () => withTmpWorkspace(async (ws, dir) => {
  const store = new SettingsStore(ws, DEFAULT_CONFIG, undefined, undefined, undefined, async () => {
    throw new AppError('unavailable', 'credentials_unavailable');
  });
  await assert.rejects(store.addAccount('gemini', 'First', dir), { detail: 'credentials_unavailable' });
  const saved = await store.get();
  assert.deepEqual(saved.accounts, {});
  assert.deepEqual(saved.activeAccounts, {});
}));

test('settings patches reject unknown keys, invalid efforts, oversized models and model lists', () => withTmpWorkspace(async ws => {
  const store = new SettingsStore(ws, DEFAULT_CONFIG);
  const rejects = (patch: unknown) => assert.rejects(store.update(patch as never), (err: unknown) => err instanceof AppError && err.code === 'bad_request');
  await rejects({ junk: 1 });
  await rejects({ initial: { ai: 'codex', model: 'm', effort: 'bogus' } });
  await rejects({ initial: { ai: 'codex', model: 'm'.repeat(201), effort: 'high' } });
  await rejects({ initial: { ai: 'codex', model: 'bad\nmodel', effort: 'high' } });
  await rejects({ hiddenModels: { codex: Array.from({ length: 501 }, (_, i) => `m${i}`) } });
  await rejects({ modelOrder: { codex: ['m'.repeat(201)] } });
  const saved = await store.update({ initial: { ai: 'codex', model: 'm'.repeat(200), effort: '' }, hiddenModels: { codex: ['a'] } });
  assert.equal(saved.initial.effort, ''); assert.deepEqual(saved.hiddenModels, { codex: ['a'] });
}));

test('removing the active account hands the default slot to the next account, or empties it', () => withTmpWorkspace(async (ws, dir) => {
  const slot: Record<string, string | undefined> = {};
  const forgotten: string[] = [];
  let broken = '';
  const store = new SettingsStore(ws, DEFAULT_CONFIG, undefined, undefined, undefined, async (ai, directory) => {
    if (directory !== undefined && directory === broken) throw new AppError('unavailable', 'credentials_unavailable');
    slot[ai] = directory;
  }, async (_ai, directory) => { forgotten.push(directory); });
  const dirs = ['one', 'two', 'three'].map(name => path.join(dir, name));
  for (const folder of dirs) await fs.mkdir(folder);
  for (const [index, folder] of dirs.entries()) await store.addAccount('codex', `A${index}`, folder);
  const [one, two, three] = (await store.get()).accounts.codex!;
  // Removing an inactive account leaves the selection and the slot alone.
  let settings = await store.removeAccount('codex', two!.id);
  assert.equal(settings.activeAccounts.codex, one!.id);
  assert.equal(slot.codex, dirs[0]);
  assert.deepEqual(forgotten, [dirs[1]]);
  // Removing the active one selects the next account and copies its credentials into the slot.
  settings = await store.removeAccount('codex', one!.id);
  assert.equal(settings.activeAccounts.codex, three!.id);
  assert.equal(slot.codex, dirs[2]);
  // The last account leaves an empty slot rather than the removed account's credentials.
  settings = await store.removeAccount('codex', three!.id);
  assert.equal(settings.activeAccounts.codex, 'default');
  assert.equal(slot.codex, undefined);
  assert.ok('codex' in slot);
  assert.deepEqual(forgotten, [dirs[1], dirs[0], dirs[2]]);
  // A next account whose credentials cannot be activated is not selected; the slot is emptied instead.
  await store.addAccount('claude', 'First', dirs[0]!);
  await store.addAccount('claude', 'Broken', dirs[1]!);
  broken = dirs[1]!;
  const claude = (await store.get()).accounts.claude!;
  settings = await store.removeAccount('claude', claude[0]!.id);
  assert.equal(settings.activeAccounts.claude, 'default');
  assert.equal(slot.claude, undefined);
  assert.deepEqual(settings.accounts.claude!.map(account => account.name), ['Broken']);
}));

test('a rejected selection switches no credentials, and removing an account under the default label revokes the slot', () => withTmpWorkspace(async (ws, dir) => {
  const slot: Record<string, string | undefined> = {};
  const store = new SettingsStore(ws, DEFAULT_CONFIG, undefined, undefined, undefined, async (ai, directory) => { slot[ai] = directory; });
  const [a, b] = [path.join(dir, 'a'), path.join(dir, 'b')];
  await fs.mkdir(a); await fs.mkdir(b);
  await store.addAccount('codex', 'A', a);
  await store.addAccount('codex', 'B', b);
  const [first, second] = (await store.get()).accounts.codex!;
  // One unknown id rejects the whole patch before any slot is touched.
  await assert.rejects(store.update({ activeAccounts: { codex: second!.id, gemini: 'does-not-exist' } }), { code: 'not_found' });
  assert.equal(slot.codex, a);
  assert.equal((await store.get()).activeAccounts.codex, first!.id);
  // With the 'default' label no account owns the slot, which still holds A's copy: removing A must not leave it usable.
  await store.update({ activeAccounts: { codex: 'default' } });
  assert.equal(slot.codex, a);
  await store.removeAccount('codex', first!.id);
  assert.equal(slot.codex, undefined);
  assert.ok('codex' in slot);
  assert.equal((await store.get()).activeAccounts.codex, 'default');
}));

test('removing an account while switching to it leaves the slot and the selection on the same remaining account', () => withTmpWorkspace(async (ws, dir) => {
  const slot: Record<string, string | undefined> = {};
  let pause: Promise<void> | undefined; let entered!: () => void; const activating = new Promise<void>(resolve => { entered = resolve; });
  const store = new SettingsStore(ws, DEFAULT_CONFIG, undefined, undefined, undefined, async (ai, directory) => {
    slot[ai] = directory;
    if (pause) { const wait = pause; pause = undefined; entered(); await wait; }
  });
  const [a, b] = [path.join(dir, 'a'), path.join(dir, 'b')];
  await fs.mkdir(a); await fs.mkdir(b);
  await store.addAccount('codex', 'B', b);
  await store.addAccount('codex', 'A', a);
  const target = (await store.get()).accounts.codex!.find(account => account.name === 'A')!;
  let release!: () => void; pause = new Promise<void>(resolve => { release = resolve; });
  const switching = store.update({ activeAccounts: { codex: target.id } });
  await activating;
  const removing = store.removeAccount('codex', target.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await switching; await removing;
  const settings = await store.get();
  assert.deepEqual(settings.accounts.codex!.map(account => account.name), ['B']);
  assert.equal(settings.activeAccounts.codex, settings.accounts.codex![0]!.id);
  assert.equal(slot.codex, b, 'the slot holds the selected account, never the removed one');
}));
