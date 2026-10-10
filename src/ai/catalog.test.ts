import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Workspace } from '../ledger/workspace.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import type { Settings } from '../shared/types.ts';
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
  const settings: Settings = { initial: { ai: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, hiddenModels: {}, modelOrder: {}, fullAccess: {}, accounts: {}, activeAccounts: {} };
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
  await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');\nif (args.join(' ') === '--version') console.log('codex-cli ' + fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8'));\nelse if (args.join(' ') === 'debug models') console.log(${JSON.stringify(JSON.stringify(CODEX_CACHE))});\nelse if (args.join(' ') === 'update') fs.writeFileSync(${JSON.stringify(versionFile)}, '0.161.0');\nelse process.exit(2);\n`, { mode: 0o755 });
  f.config.cli.codex.command = command;
  assert.equal((await f.catalog.get('codex')).version, '0.160.1');
  assert.equal((await f.catalog.get('codex')).available, true);
  const refreshed = await f.catalog.refresh('codex');
  assert.equal(refreshed.source, 'cli');
  assert.equal(refreshed.models[0]!.defaultEffort, 'high');
  assert.deepEqual(await f.catalog.update('codex'), { before: '0.160.1', after: '0.161.0' });
  const argv = (await fs.readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(argv.some((args) => args.join(' ') === 'debug models'));
  assert.ok(argv.some((args) => args.join(' ') === 'update'));
  assert.ok(argv.every((args) => ['--version', 'debug models', 'update'].includes(args.join(' '))));
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
