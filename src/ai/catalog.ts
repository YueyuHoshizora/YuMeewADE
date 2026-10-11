// 模型清單與 CLI 維護；完整清單保留給設定頁，隱藏／排序由選單依 settings 套用。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureCommand, findExecutable, minimalEnv, type CommandCapture } from '../cli/process.ts';
import { grokEnv } from '../cli/grok.ts';
import type { CredentialAccounts } from '../cli/accounts.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { writeJson } from '../shared/fsx.ts';
import type { AiInfo, ModelInfo, Settings } from '../shared/types.ts';

type CatalogAi = 'claude' | 'codex' | 'grok' | 'gemini';
type ModelCache = Pick<AiInfo, 'models' | 'source' | 'refreshedAt'> & { profile?: string };
const NAMES: CatalogAi[] = ['claude', 'codex', 'grok', 'gemini'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BUILTIN: Record<CatalogAi, [string, string][]> = {
  claude: [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-haiku-5-5', 'Haiku 5.5']],
  codex: [['gpt-6.1-sol', 'GPT-6.1-Sol'], ['gpt-6-astra', 'GPT-6-Astra']],
  grok: [],
  gemini: [],
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function efforts(value: unknown, key: string): string[] {
  return [...new Set(array(value).map((entry) => text(object(entry)[key])).filter(Boolean))];
}
function parseModels(ai: CatalogAi, value: unknown): ModelInfo[] {
  const root = object(value);
  const entries = ai === 'claude' ? object(object(root['catalog'])['config'])['models'] : root['models'];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of array(entries)) {
    const row = object(entry);
    if (ai === 'claude' ? row['section'] !== 'main' : row['visibility'] !== 'list') continue;
    const id = text(row[ai === 'claude' ? 'id' : 'slug']);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const options = object(row['thinking'])['effort_options'];
    const supported = ai === 'claude' ? efforts(options, 'id') : efforts(row['supported_reasoning_levels'], 'effort');
    const recommended = array(options).find((option) => object(object(option)['badge'])['message'] === 'Recommended');
    models.push({
      id,
      label: text(row[ai === 'claude' ? 'name' : 'display_name']) || id,
      efforts: supported,
      defaultEffort: ai === 'claude' ? text(object(recommended)['id']) || 'medium' : text(row['default_reasoning_level']) || 'medium',
    });
  }
  return models;
}

// `grok models` has no JSON option. Only its selectable list is authoritative;
// cache metadata enriches matching entries, never introduces additional models.
export function parseGrokModels(stdout: string, metadata: unknown): ModelInfo[] {
  const section = stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/^Available models:\s*$/m)[1];
  if (!section) return [];
  const cached = object(object(metadata)['models']);
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s+[*-]\s+(\S+?)(?:\s+\(default\))?\s*$/.exec(line);
    const id = match?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const info = object(object(cached[id])['info']);
    const options = array(info['reasoning_efforts']);
    const supported = info['id'] === id && info['supports_reasoning_effort'] === true ? efforts(options, 'value') : [];
    const preferred = text(object(options.find((option) => object(option)['default'] === true))['value']) || text(info['reasoning_effort']);
    models.push({ id, label: info['id'] === id ? text(info['name']) || id : id, efforts: supported, defaultEffort: supported.includes(preferred) ? preferred : '' });
  }
  return models;
}

// `agy models` prints a status line then "id<TAB>label" rows; reasoning level is part of the model id.
export function parseGeminiModels(stdout: string): ModelInfo[] {
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const [id, label] = line.split('\t');
    if (!id || !label || !/^[\w.-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: label.trim() || id, efforts: [], defaultEffort: '' });
  }
  return models;
}
async function json(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch (err) {
    if (err instanceof SyntaxError || ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw err;
  }
}
function savedCache(value: unknown): ModelCache | undefined {
  const row = object(value);
  const models = array(row['models']);
  if ((!models.length && row['source'] !== 'unavailable') || !['cli-cache', 'cli', 'builtin', 'unavailable'].includes(text(row['source'])) || !text(row['refreshedAt'])) return undefined;
  if (!models.every((model) => {
    const m = object(model);
    return text(m['id']) && text(m['label']) && Array.isArray(m['efforts']) && m['efforts'].every((effort: unknown) => typeof effort === 'string') && typeof m['defaultEffort'] === 'string';
  })) return undefined;
  return { models: models as ModelInfo[], source: text(row['source']), refreshedAt: text(row['refreshedAt']), ...(typeof row['profile'] === 'string' ? { profile: row['profile'] } : {}) };
}

export class AiCatalog {
  private readonly config: Config;
  private readonly settings: { get(): Promise<Settings> };
  private readonly home: string;
  private readonly file: string;
  private readonly cache: Partial<Record<CatalogAi, ModelCache>> = {};
  private initialized: Promise<void> | undefined;
  // 將 AI 的更新與原子寫入序列化，避免同時 refresh 遺失另一側清單。
  private writes: Promise<void> = Promise.resolve();
  private readonly accounts: CredentialAccounts | undefined;

  constructor(deps: { config: Config; ws: Workspace; settings: { get(): Promise<Settings> }; home?: string; accounts?: CredentialAccounts }) {
    this.config = deps.config;
    this.settings = deps.settings;
    this.home = deps.home ?? os.homedir();
    this.file = path.join(deps.ws.internalDir, 'models.json');
    this.accounts = deps.accounts;
  }

  async list(): Promise<AiInfo[]> { return Promise.all(NAMES.map((name) => this.get(name))); }

  async get(ai: string): Promise<AiInfo> {
    const name = this.name(ai);
    await this.init();
    const [status, settings] = await Promise.all([this.status(name), this.settings.get()]);
    if (name === 'grok' && this.cache.grok?.profile !== this.grokProfile(settings)) {
      await this.loadGrok(settings, false);
    }
    const cached = this.cache[name]!;
    return { name, ...status, models: structuredClone(cached.models), source: cached.source, refreshedAt: cached.refreshedAt, fullAccess: settings.fullAccess[name] ?? this.config.cli[name].fullAccess };
  }

  async refresh(ai: string): Promise<AiInfo> {
    const name = this.name(ai);
    await this.init();
    let models: ModelInfo[];
    let source = 'cli-cache';
    if (name === 'grok') {
      await this.loadGrok(await this.settings.get(), true);
      return this.get(name);
    }
    if (name === 'gemini') {
      await this.loadGemini(true);
      return this.get(name);
    }
    if (name === 'codex') {
      const query = (env: NodeJS.ProcessEnv) => captureCommand({ command: this.config.cli[name].command, args: ['debug', 'models', '-c', 'cli_auth_credentials_store="file"'], env, timeoutMs: 120_000 });
      const settings = await this.settings.get();
      const result = this.accounts ? await this.accounts.withEnv(name, this.configDir(name, settings), query) : await query(this.env());
      if (!result.ok) throw new AppError('unavailable', 'cli_unavailable', { field: name, cause: result.reason });
      try { models = parseModels(name, JSON.parse(result.stdout)); }
      catch (cause) { throw new AppError('internal', 'bad_json', { cause }); }
      if (!models.length) throw new AppError('internal', 'bad_json');
      source = 'cli';
    } else {
      models = await this.localModels(name);
      if (!models.length) {
        models = BUILTIN[name].map(([id, label]) => ({ id, label, efforts: [...EFFORTS], defaultEffort: 'medium' }));
        source = 'builtin';
      }
    }
    await this.persist(name, { models, source, refreshedAt: new Date().toISOString() });
    return this.get(name);
  }

  async update(ai: string): Promise<{ before: string; after: string }> {
    const name = this.name(ai);
    const before = (await this.status(name)).version;
    const result = await captureCommand({ command: this.config.cli[name].command, args: ['update'], env: this.env(), timeoutMs: 300_000 });
    if (!result.ok) throw new AppError('unavailable', 'cli_unavailable', { field: name, cause: result.reason });
    return { before, after: (await this.status(name)).version };
  }

  private name(ai: string): CatalogAi {
    if (ai !== 'claude' && ai !== 'codex' && ai !== 'grok' && ai !== 'gemini') throw new AppError('bad_request', 'cli_unsupported', { field: ai });
    return ai;
  }
  private configDir(ai: CatalogAi, settings: Settings): string | undefined {
    const active = settings.activeAccounts[ai] ?? 'default';
    return settings.accounts[ai]?.find(account => account.id === active)?.configDir;
  }
  private env(): NodeJS.ProcessEnv { return { ...minimalEnv(this.config.cli.envPassthrough), HOME: this.home }; }
  private grokHome(settings: Settings): string {
    const active = settings.activeAccounts.grok ?? 'default';
    return settings.accounts.grok?.find((account) => account.id === active)?.configDir || this.env()['GROK_HOME'] || path.join(this.home, '.grok');
  }
  private grokEnv(settings: Settings): NodeJS.ProcessEnv {
    const active = settings.activeAccounts.grok ?? 'default';
    const account = settings.accounts.grok?.find((entry) => entry.id === active);
    return grokEnv({ ...this.env(), GROK_HOME: this.grokHome(settings) }, account?.configDir);
  }
  private grokProfile(settings: Settings): string {
    const env = this.grokEnv(settings);
    return JSON.stringify([env['GROK_HOME'], env['GROK_AUTH_PATH'] || '']);
  }
  private async loadGrok(settings: Settings, strict: boolean): Promise<void> {
    const env = this.grokEnv(settings);
    const profile = this.grokProfile(settings);
    const query = async (runtimeEnv: NodeJS.ProcessEnv) => {
      const result = await captureCommand({ command: this.config.cli.grok.command, args: ['models'], env: runtimeEnv, timeoutMs: 120_000 });
      const models = result.ok ? parseGrokModels(result.stdout, await json(path.join(runtimeEnv['GROK_HOME']!, 'models_cache.json'))) : [];
      return { result, models };
    };
    let result: CommandCapture;
    let models: ModelInfo[];
    try {
      ({ result, models } = this.accounts ? await this.accounts.withEnv('grok', this.configDir('grok', settings), query) : await query(env));
    } catch {
      result = { ok: false, stdout: '', stderr: '', reason: 'Account credentials unavailable.' };
      models = [];
    }
    if (strict && !result.ok) throw new AppError('unavailable', 'cli_unavailable', { field: 'grok', cause: result.reason });
    if (strict && !models.length) throw new AppError('internal', 'bad_json');
    await this.persist('grok', { models, source: models.length ? 'cli' : 'unavailable', refreshedAt: new Date().toISOString(), profile });
  }
  private async loadGemini(strict: boolean): Promise<void> {
    const result = await captureCommand({ command: this.config.cli.gemini.command, args: ['models'], env: this.env(), timeoutMs: 120_000 });
    const models = result.ok ? parseGeminiModels(result.stdout) : [];
    if (strict && !result.ok) throw new AppError('unavailable', 'cli_unavailable', { field: 'gemini', cause: result.reason });
    if (strict && !models.length) throw new AppError('internal', 'bad_json');
    await this.persist('gemini', { models, source: models.length ? 'cli' : 'unavailable', refreshedAt: new Date().toISOString() });
  }
  private async status(ai: CatalogAi): Promise<{ available: boolean; version: string }> {
    const command = this.config.cli[ai].command;
    const env = this.env();
    if (!(await findExecutable(command, env))) return { available: false, version: '' };
    const result = await captureCommand({ command, args: ['--version'], env, timeoutMs: 10_000 });
    return { available: true, version: result.ok ? /\b\d+\.\d+\.\d+\b/.exec(result.stdout + '\n' + result.stderr)?.[0] ?? '' : '' };
  }
  private async localModels(ai: CatalogAi): Promise<ModelInfo[]> {
    if (ai === 'grok' || ai === 'gemini') return [];
    if (ai === 'codex') return parseModels(ai, await json(path.join(this.home, '.codex', 'models_cache.json')));
    const dir = path.join(this.home, '.claude', 'cache', 'model-catalog');
    let files: string[];
    try { files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json')); }
    catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return [];
      throw err;
    }
    const candidates = await Promise.all(files.map(async (file) => {
      try { const stat = await fs.stat(path.join(dir, file)); return { file, mtime: stat.isFile() ? stat.mtimeMs : -1 }; }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { file, mtime: -1 }; throw err; }
    }));
    candidates.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
    const newest = candidates.find((candidate) => candidate.mtime >= 0);
    return newest ? parseModels(ai, await json(path.join(dir, newest.file))) : [];
  }
  private init(): Promise<void> {
    this.initialized ??= (async () => {
      const saved = object(await json(this.file));
      for (const name of NAMES) {
        if (name === 'gemini') {
          const existing = savedCache(saved.gemini);
          if (existing) this.cache.gemini = existing;
          else { this.cache.gemini = { models: [], source: 'unavailable', refreshedAt: new Date().toISOString() }; await this.loadGemini(false).catch(() => undefined); }
          continue;
        }
        if (name === 'grok') {
          this.cache.grok = { models: [], source: 'unavailable', refreshedAt: new Date().toISOString() };
          const existing = savedCache(saved.grok);
          if (existing?.profile) this.cache.grok = existing;
          continue;
        }
        const existing = savedCache(saved[name]);
        if (existing) { this.cache[name] = existing; continue; }
        const models = await this.localModels(name);
        this.cache[name] = {
          models: models.length ? models : BUILTIN[name].map(([id, label]) => ({ id, label, efforts: [...EFFORTS], defaultEffort: 'medium' })),
          source: models.length ? 'cli-cache' : 'builtin',
          refreshedAt: new Date().toISOString(),
        };
      }
      await writeJson(this.file, this.cache);
    })();
    return this.initialized;
  }
  private persist(name: CatalogAi, value: ModelCache): Promise<void> {
    const write = this.writes.then(async () => {
      this.cache[name] = value;
      await writeJson(this.file, this.cache);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
