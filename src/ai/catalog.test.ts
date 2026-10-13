import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Workspace } from '../ledger/workspace.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import type { Settings } from '../shared/types.ts';
import { CredentialAccounts } from '../cli/accounts.ts';
import { compareVersions } from '../system/update.ts';
import { AiCatalog, parseGrokModels } from './catalog.ts';

const CLAUDE_CACHE = {
  catalog: { config: { models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', thinking: { effort_options: [
      { id: 'low', name: 'Low' }, { id: 'high', name: 'High', badge: { message: 'Recommended' } }, { id: 'max', name: 'Max' },
    ] } },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main', thinking: { effort_options: [{ id: 'medium' }, { id: 'high' }] } },
    { id: 'claude-hidden', name: 'Other', section: 'other', thinking: { effort_options: [{ id: 'high' }] } },
  ] } },
};
const CODEX_CACHE = {
  fetched_at: '2026-10-10T00:00:00Z', client_version: '0.160.1',
  models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low', description: 'Low' }, { effort: 'high', description: 'High' }, { effort: 'xhigh', description: 'Extra high' }] },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] },
  ],
};

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const ws = new Workspace(path.join(root, 'workspace'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.cli.claude.command = path.join(root, 'missing-claude');
  config.cli.codex.command = path.join(root, 'missing-codex');
  config.cli.grok.command = path.join(root, 'missing-grok');
  config.cli.gemini.command = path.join(root, 'missing-gemini');
  const settings: Settings = { initial: { ai: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, hiddenModels: {}, modelOrder: {}, fullAccess: {}, accounts: {}, activeAccounts: {} };
  // Keep inherited CLI-home pointers from reaching the developer's real profiles.
  settings.accounts.claude = [{ id: 'default', name: 'Default', configDir: path.join(home, '.claude') }];
  settings.accounts.codex = [{ id: 'default', name: 'Default', configDir: path.join(home, '.codex') }];
  const deps = { config, ws, home, settings: { async get() { return settings; } } };
  return { root, home, ws, config, settings, deps, catalog: new AiCatalog(deps) };
}
async function put(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

test('Claude uses newest mtime, main models, real effort badges; codex uses visible cache list', async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.home, '.claude/cache/model-catalog');
  const old = path.join(dir, 'z-old.json');
  const newest = path.join(dir, 'a-new.json');
  await put(old, { catalog: { config: { models: [{ id: 'old', name: 'Old', section: 'main' }] } } });
  await put(newest, CLAUDE_CACHE);
  await fs.utimes(old, new Date('2025-01-01'), new Date('2025-01-01'));
  await fs.utimes(newest, new Date('2026-01-01'), new Date('2026-01-01'));
  await put(path.join(f.home, '.codex/models_cache.json'), CODEX_CACHE);
  const [claude, codex] = await f.catalog.list();
  assert.equal(claude!.source, 'cli-cache');
  assert.deepEqual(claude!.models, [
    { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['medium', 'high'], defaultEffort: 'medium' },
  ]);
  assert.deepEqual(codex!.models, [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' }]);
  assert.equal(codex!.available, false);
  assert.equal(codex!.version, '');
  const saved = JSON.parse(await fs.readFile(path.join(f.ws.internalDir, 'models.json'), 'utf8'));
  assert.deepEqual(saved.claude.models, claude!.models);
  assert.deepEqual(saved.codex.models, codex!.models);
  assert.ok(saved.claude.refreshedAt);
});

test('missing and malformed caches use builtin lists; settings are read per get and models remain complete', async (t) => {
  const f = await fixture(t);
  await put(path.join(f.home, '.codex/models_cache.json'), { models: [{ slug: 'hidden', visibility: 'hide' }] });
  const claudeFile = path.join(f.home, '.claude/cache/model-catalog/bad.json');
  await put(claudeFile, {});
  await fs.writeFile(claudeFile, '{broken');
  const claude = await f.catalog.get('claude');
  assert.equal(claude.source, 'builtin');
  assert.deepEqual(claude.models.map((model) => model.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5']);
  assert.deepEqual(claude.models[0]!.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(claude.fullAccess, true);
  f.settings.fullAccess.claude = false;
  f.settings.hiddenModels.claude = ['claude-opus-5-5'];
  assert.equal((await f.catalog.get('claude')).fullAccess, false);
  assert.equal((await f.catalog.get('claude')).models.length, 4);
  assert.deepEqual((await f.catalog.get('codex')).models.map((model) => model.id), ['gpt-6.1-sol', 'gpt-6-astra']);
  claude.models[0]!.efforts.push('mutation');
  assert.ok(!(await f.catalog.get('claude')).models[0]!.efforts.includes('mutation'));
  await assert.rejects(f.catalog.get('mock'), (err: unknown) => err instanceof AppError && err.detail === 'cli_unsupported');
});

test('an unreadable CLI cache falls back to builtins, and a failed start retries instead of failing forever', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, '.codex/models_cache.json'), { recursive: true });
  await fs.mkdir(path.join(f.home, '.claude/cache/model-catalog/models.json'), { recursive: true });
  const [claude, codex] = await f.catalog.list();
  assert.equal(claude!.source, 'builtin'); assert.equal(codex!.source, 'builtin');
  // The App's own catalog file unreadable: this call fails, the next one (after repair) works.
  const other = await fixture(t);
  await fs.mkdir(path.join(other.ws.internalDir, 'models.json'), { recursive: true });
  await assert.rejects(other.catalog.list());
  await fs.rm(path.join(other.ws.internalDir, 'models.json'), { recursive: true });
  assert.equal((await other.catalog.list()).length, 4);
});

test('Claude refresh only rereads local cache and persisted catalog survives restart', async (t) => {
  const f = await fixture(t);
  await f.catalog.get('claude');
  const file = path.join(f.home, '.claude/cache/model-catalog/models.json');
  await put(file, CLAUDE_CACHE);
  const refreshed = await f.catalog.refresh('claude');
  assert.equal(refreshed.source, 'cli-cache');
  assert.equal(refreshed.models[0]!.defaultEffort, 'high');
  await fs.rm(file);
  const restored = await new AiCatalog(f.deps).get('claude');
  assert.deepEqual(restored.models, refreshed.models);
  assert.equal(restored.refreshedAt, refreshed.refreshedAt);
});

test('CLI version, codex refresh and update use configured executable without chat flags', async (t) => {
  const f = await fixture(t);
  const command = path.join(f.root, 'test-cli');
  const versionFile = path.join(f.root, 'version');
  const calls = path.join(f.root, 'calls.jsonl');
  await fs.writeFile(versionFile, '0.160.1');
  await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');\nif (args.join(' ') === '--version') console.log('codex-cli ' + fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8'));\nelse if (args.join(' ') === 'debug models -c cli_auth_credentials_store=\"file\"') console.log(${JSON.stringify(JSON.stringify(CODEX_CACHE))});\nelse if (args.join(' ') === 'update') fs.writeFileSync(${JSON.stringify(versionFile)}, '0.161.0');\nelse process.exit(2);\n`, { mode: 0o755 });
  f.config.cli.codex.command = command;
  assert.equal((await f.catalog.get('codex')).version, '0.160.1');
  assert.equal((await f.catalog.get('codex')).available, true);
  const refreshed = await f.catalog.refresh('codex');
  assert.equal(refreshed.source, 'cli');
  assert.equal(refreshed.models[0]!.defaultEffort, 'high');
  // A second request while the first is still installing joins it instead of running `update` twice.
  assert.deepEqual(await Promise.all([f.catalog.update('codex'), f.catalog.update('codex')]), [{ before: '0.160.1', after: '0.161.0' }, { before: '0.160.1', after: '0.161.0' }]);
  const argv = (await fs.readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(argv.some((args) => args.join(' ') === 'debug models -c cli_auth_credentials_store=\"file\"'));
  assert.equal(argv.filter((args) => args.join(' ') === 'update').length, 1);
  assert.ok(argv.every((args) => ['--version', 'debug models -c cli_auth_credentials_store=\"file\"', 'update'].includes(args.join(' '))));
  const persisted = JSON.parse(await fs.readFile(path.join(f.ws.internalDir, 'models.json'), 'utf8'));
  assert.equal(persisted.codex.source, 'cli');
});

test('refresh/update failures do not replace the persisted codex models', async (t) => {
  const f = await fixture(t);
  const initial = await f.catalog.get('codex');
  await assert.rejects(f.catalog.refresh('codex'), (err: unknown) => err instanceof AppError && err.detail === 'cli_unavailable');
  await assert.rejects(f.catalog.update('codex'), (err: unknown) => err instanceof AppError && err.detail === 'cli_unavailable');
  assert.deepEqual((await f.catalog.get('codex')).models, initial.models);
});

test('Grok parses only the live selectable list and enriches real per-model capabilities', () => {
  const metadata = { models: {
    'grok-4.7': { info: { id: 'grok-4.7', name: 'Grok 4.7', supports_reasoning_effort: true, reasoning_effort: 'high', reasoning_efforts: [
      { value: 'xhigh' }, { value: 'high', default: true }, { value: 'medium' }, { value: 'low' },
    ] } },
    'grok-4.5': { info: { id: 'grok-4.5', name: 'Grok 4.5', supports_reasoning_effort: true, reasoning_effort: 'high', reasoning_efforts: [
      { value: 'high', default: true }, { value: 'medium' }, { value: 'low' },
    ] } },
    'cache-only': { info: { id: 'cache-only', name: 'Not selectable' } },
    'no-reasoning': { info: { id: 'no-reasoning', supports_reasoning_effort: false, reasoning_efforts: [{ value: 'high', default: true }] } },
    'mismatched': { info: { id: 'another-model', name: 'Wrong', supports_reasoning_effort: true, reasoning_efforts: [{ value: 'high' }] } },
  } };
  const stdout = 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.5\n  - unknown-model\n  - no-reasoning\n  - mismatched\n  - grok-4.7\n';
  assert.deepEqual(parseGrokModels(stdout, metadata), [
    { id: 'grok-4.7', label: 'Grok 4.7', efforts: ['xhigh', 'high', 'medium', 'low'], defaultEffort: 'high' },
    { id: 'grok-4.5', label: 'Grok 4.5', efforts: ['high', 'medium', 'low'], defaultEffort: 'high' },
    { id: 'unknown-model', label: 'unknown-model', efforts: [], defaultEffort: '' },
    { id: 'no-reasoning', label: 'no-reasoning', efforts: [], defaultEffort: '' },
    { id: 'mismatched', label: 'mismatched', efforts: [], defaultEffort: '' },
  ]);
});

test('Grok never infers models or efforts from defaults, arbitrary output or incomplete metadata', () => {
  assert.deepEqual(parseGrokModels('Default model: grok-4.7\n  - grok-4.7', {}), []);
  assert.deepEqual(parseGrokModels('Available models:\nAuthentication failed\n', {}), []);
  assert.deepEqual(parseGrokModels('Available models:\r\n  - custom\r\n', { models: { custom: { info: {
    id: 'custom', supports_reasoning_effort: true, reasoning_effort: 'high', reasoning_efforts: [{ value: 'low' }, { value: 'low' }, {}],
  } } } }), [{ id: 'custom', label: 'custom', efforts: ['low'], defaultEffort: '' }]);
});

test('unavailable Grok has no invented fallback models and refresh/update failures preserve state', async (t) => {
  const f = await fixture(t);
  const initial = await f.catalog.get('grok');
  assert.equal(initial.available, false);
  assert.equal(initial.version, '');
  assert.equal(initial.source, 'unavailable');
  assert.deepEqual(initial.models, []);
  await assert.rejects(f.catalog.refresh('grok'), (err: unknown) => err instanceof AppError && err.detail === 'cli_unavailable');
  await assert.rejects(f.catalog.update('grok'), (err: unknown) => err instanceof AppError && err.detail === 'cli_unavailable');
  assert.deepEqual((await new AiCatalog(f.deps).get('grok')).models, []);
  assert.equal((await f.catalog.get('grok')).refreshedAt, initial.refreshedAt);
});

test('Grok saved model capabilities survive restart but never leak to another account profile', async (t) => {
  const f = await fixture(t);
  const models = [{ id: 'verified-model', label: 'Verified', efforts: ['high', 'low'], defaultEffort: 'high' }];
  const refreshedAt = '2026-10-10T00:00:00.000Z';
  await put(path.join(f.ws.internalDir, 'models.json'), {
    grok: { models, source: 'cli', refreshedAt, profile: JSON.stringify([path.join(f.home, '.grok'), '']) },
  });
  assert.deepEqual((await f.catalog.get('grok')).models, models);
  assert.equal((await new AiCatalog(f.deps).get('grok')).refreshedAt, refreshedAt);
  f.settings.accounts.grok = [{ id: 'extra', name: 'Extra', configDir: path.join(f.root, 'isolated-profile') }];
  f.settings.activeAccounts.grok = 'extra';
  const isolated = await f.catalog.get('grok');
  assert.deepEqual(isolated.models, []);
  assert.equal(isolated.source, 'unavailable');
  const saved = JSON.parse(await fs.readFile(path.join(f.ws.internalDir, 'models.json'), 'utf8'));
  assert.equal(saved.grok.profile, JSON.stringify([path.join(f.root, 'isolated-profile'), path.join(f.root, 'isolated-profile', 'auth.json')]));
  assert.ok(saved.claude.models.length);
  assert.ok(saved.codex.models.length);
});

test('Gemini discovery follows the selected account and scopes persisted models to its profile', async (t) => {
  const f = await fixture(t);
  const command = path.join(f.root, 'gemini-cli');
  await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nif (process.argv[2] === '--version') console.log('agy 1.2.3');\nelse console.log(fs.readFileSync(process.env.HOME + '/models.txt', 'utf8'));\n`, { mode: 0o755 });
  f.config.cli.gemini.command = command;
  const firstHome = path.join(f.root, 'first');
  const secondHome = path.join(f.root, 'second');
  for (const [home, model] of [[f.home, 'default-model'], [firstHome, 'first-model'], [secondHome, 'second-model']]) {
    await fs.mkdir(home!, { recursive: true });
    await fs.writeFile(path.join(home!, 'models.txt'), `${model}\t${model}\n`);
  }
  f.settings.accounts.gemini = [{ id: 'first', name: 'First', configDir: firstHome }, { id: 'second', name: 'Second', configDir: secondHome }];
  f.settings.activeAccounts.gemini = 'first';
  // Keep the test seam at the credential lease boundary; the fake CLI still reads its actual HOME.
  const accounts = Object.create(CredentialAccounts.prototype) as CredentialAccounts;
  accounts.withEnv = async <T>(_ai: string, configDir: string | undefined, query: (env: NodeJS.ProcessEnv) => Promise<T>) => query({ ...process.env, HOME: configDir ?? f.home });
  const deps = { ...f.deps, accounts };
  const catalog = new AiCatalog(deps);
  assert.deepEqual((await catalog.get('gemini')).models.map(model => model.id), ['first-model']);
  const first = await catalog.refresh('gemini');
  await fs.writeFile(path.join(firstHome, 'models.txt'), 'changed-model\tChanged\n');
  assert.deepEqual((await new AiCatalog(deps).get('gemini')).models, first.models);
  f.settings.activeAccounts.gemini = 'second';
  assert.deepEqual((await catalog.get('gemini')).models.map(model => model.id), ['second-model']);
  assert.deepEqual((await new AiCatalog(deps).get('gemini')).models.map(model => model.id), ['second-model']);
  f.settings.activeAccounts.gemini = 'first';
  assert.deepEqual((await new AiCatalog(deps).get('gemini')).models.map(model => model.id), ['changed-model']);
  const saved = JSON.parse(await fs.readFile(path.join(f.ws.internalDir, 'models.json'), 'utf8'));
  assert.equal(saved.gemini.profile, JSON.stringify(['first', firstHome]));
});

for (const ai of ['claude', 'codex'] as const) {
  const cacheFile = (home: string) => path.join(home, ai === 'claude' ? 'cache/model-catalog/models.json' : 'models_cache.json');
  const cache = (id: string) => ai === 'claude'
    ? { catalog: { config: { models: [{ id, name: id, section: 'main' }] } } }
    : { models: [{ slug: id, display_name: id, visibility: 'list' }] };

  test(`${ai} initial lookup and refresh read the selected account config directory`, async (t) => {
    const f = await fixture(t);
    const selected = path.join(f.root, 'selected');
    await put(cacheFile(path.join(f.home, `.${ai}`)), cache('default-model'));
    await put(cacheFile(selected), cache('selected-model'));
    f.settings.accounts[ai] = [{ id: 'selected', name: 'Selected', configDir: selected }];
    f.settings.activeAccounts[ai] = 'selected';
    const command = path.join(f.root, 'catalog-cli');
    await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nif (process.argv[2] === '--version') console.log('cli 1.2.3');\nelse console.log(fs.readFileSync(process.env.CODEX_HOME + '/models_cache.json', 'utf8'));\n`, { mode: 0o755 });
    f.config.cli[ai].command = command;
    assert.deepEqual((await f.catalog.get(ai)).models.map(model => model.id), ['selected-model']);
    await put(cacheFile(selected), cache('refreshed-model'));
    assert.deepEqual((await f.catalog.refresh(ai)).models.map(model => model.id), ['refreshed-model']);
    await fs.rm(cacheFile(selected));
    assert.deepEqual((await new AiCatalog(f.deps).get(ai)).models.map(model => model.id), ['refreshed-model']);
  });

  test(`${ai} refreshed catalogs never leak across account switches or restarts`, async (t) => {
    const f = await fixture(t);
    const first = path.join(f.home, `.${ai}`);
    const second = path.join(f.root, 'second');
    await put(cacheFile(first), cache('first-model'));
    await put(cacheFile(second), cache('second-model'));
    f.settings.accounts[ai] = [{ id: 'default', name: 'Default', configDir: first }, { id: 'second', name: 'Second', configDir: second }];
    const command = path.join(f.root, 'catalog-cli');
    await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nif (process.argv[2] === '--version') console.log('cli 1.2.3');\nelse console.log(fs.readFileSync(process.env.CODEX_HOME + '/models_cache.json', 'utf8'));\n`, { mode: 0o755 });
    f.config.cli[ai].command = command;
    // Exercise the credential lease seam as well as the no-accounts path above.
    const accounts = Object.create(CredentialAccounts.prototype) as CredentialAccounts;
    accounts.withEnv = async <T>(_ai: string, configDir: string | undefined, query: (env: NodeJS.ProcessEnv) => Promise<T>) => query({ HOME: f.home, CODEX_HOME: configDir ?? first });
    const deps = { ...f.deps, accounts };
    const catalog = new AiCatalog(deps);
    const refreshed = await catalog.refresh(ai);
    assert.deepEqual(refreshed.models.map(model => model.id), ['first-model']);
    await fs.rm(cacheFile(first));
    assert.deepEqual((await new AiCatalog(deps).get(ai)).models, refreshed.models);
    f.settings.activeAccounts[ai] = 'second';
    // A restart must reject the first account's saved catalog before any live lookup replaces it.
    assert.deepEqual((await new AiCatalog(deps).get(ai)).models.map(model => model.id), ['second-model']);
    assert.deepEqual((await catalog.get(ai)).models.map(model => model.id), ['second-model']);
    await fs.rm(cacheFile(second));
    assert.deepEqual((await new AiCatalog(deps).get(ai)).models.map(model => model.id), ['second-model']);
    f.settings.activeAccounts[ai] = 'default';
    assert.equal((await catalog.get(ai)).source, 'builtin');
    assert.equal((await new AiCatalog(deps).get(ai)).source, 'builtin');
  });

  test(`${ai} rejects legacy unscoped saved models rather than assigning them to the active account`, async (t) => {
    const f = await fixture(t);
    const selected = path.join(f.root, 'selected');
    await put(cacheFile(selected), cache('selected-model'));
    f.settings.accounts[ai] = [{ id: 'selected', name: 'Selected', configDir: selected }];
    f.settings.activeAccounts[ai] = 'selected';
    await put(path.join(f.ws.internalDir, 'models.json'), {
      [ai]: { models: [{ id: 'other-account-model', label: 'Other', efforts: [], defaultEffort: '' }], source: 'cli', refreshedAt: '2026-10-10T00:00:00.000Z' },
    });
    assert.deepEqual((await f.catalog.get(ai)).models.map(model => model.id), ['selected-model']);
  });
}

test('CLI version retains SemVer prerelease and build identifiers with or without a v prefix', async (t) => {
  const f = await fixture(t);
  const command = path.join(f.root, 'version-cli');
  const versionFile = path.join(f.root, 'semver');
  await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nconsole.error('cli ' + fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8'));\n`, { mode: 0o755 });
  f.config.cli.codex.command = command;
  for (const token of ['v1.2.3-rc.2+build.7', '1.2.3-rc.2+build.7', 'v1.2.3', '1.2.3+build.7']) {
    await fs.writeFile(versionFile, token);
    const version = (await f.catalog.get('codex')).version;
    assert.equal(version, token.replace(/^v/, ''));
    assert.equal(compareVersions(version, token), 0);
    if (token.includes('-rc')) assert.ok(compareVersions('1.2.3', version) > 0);
  }
});
