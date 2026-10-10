import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Workspace } from '../ledger/workspace.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import type { Settings } from '../shared/types.ts';
import { AiCatalog } from './catalog.ts';

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
