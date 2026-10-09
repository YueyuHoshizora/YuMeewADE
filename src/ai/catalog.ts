// 模型清單與 CLI 維護；完整清單保留給設定頁，隱藏／排序由選單依 settings 套用。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureCommand, findExecutable, minimalEnv } from '../cli/process.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { writeJson } from '../shared/fsx.ts';
import type { AiInfo, ModelInfo, Settings } from '../shared/types.ts';

type CatalogAi = 'claude' | 'codex';
type ModelCache = Pick<AiInfo, 'models' | 'source' | 'refreshedAt'>;
const NAMES: CatalogAi[] = ['claude', 'codex'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BUILTIN: Record<CatalogAi, [string, string][]> = {
  claude: [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-haiku-5-5', 'Haiku 5.5']],
  codex: [['gpt-6.1-sol', 'GPT-6.1-Sol'], ['gpt-6-astra', 'GPT-6-Astra']],
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
  if (!models.length || !['cli-cache', 'cli', 'builtin'].includes(text(row['source'])) || !text(row['refreshedAt'])) return undefined;
  if (!models.every((model) => {
    const m = object(model);
    return text(m['id']) && text(m['label']) && Array.isArray(m['efforts']) && m['efforts'].every((effort: unknown) => typeof effort === 'string') && typeof m['defaultEffort'] === 'string';
  })) return undefined;
  return { models: models as ModelInfo[], source: text(row['source']), refreshedAt: text(row['refreshedAt']) };
}

export class AiCatalog {
  private readonly config: Config;
  private readonly settings: { get(): Promise<Settings> };
  private readonly home: string;
  private readonly file: string;
  private readonly cache: Partial<Record<CatalogAi, ModelCache>> = {};
  private initialized: Promise<void> | undefined;
  // 將兩個 AI 的更新與原子寫入序列化，避免同時 refresh 遺失另一側清單。
  private writes: Promise<void> = Promise.resolve();

  constructor(deps: { config: Config; ws: Workspace; settings: { get(): Promise<Settings> }; home?: string }) {
    this.config = deps.config;
    this.settings = deps.settings;
    this.home = deps.home ?? os.homedir();
    this.file = path.join(deps.ws.internalDir, 'models.json');
  }

  async list(): Promise<AiInfo[]> { return Promise.all(NAMES.map((name) => this.get(name))); }

  async get(ai: string): Promise<AiInfo> {
    const name = this.name(ai);
    await this.init();
    const [status, settings] = await Promise.all([this.status(name), this.settings.get()]);
    const cached = this.cache[name]!;
    return { name, ...status, ...structuredClone(cached), fullAccess: settings.fullAccess[name] ?? this.config.cli[name].fullAccess };
  }

  async refresh(ai: string): Promise<AiInfo> {
    const name = this.name(ai);
    await this.init();
    let models: ModelInfo[];
    let source = 'cli-cache';
    if (name === 'codex') {
      const result = await captureCommand({ command: this.config.cli[name].command, args: ['debug', 'models'], env: this.env(), timeoutMs: 120_000 });
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
    if (ai !== 'claude' && ai !== 'codex') throw new AppError('bad_request', 'cli_unsupported', { field: ai });
    return ai;
  }
  private env(): NodeJS.ProcessEnv { return { ...minimalEnv(this.config.cli.envPassthrough), HOME: this.home }; }
  private async status(ai: CatalogAi): Promise<{ available: boolean; version: string }> {
    const command = this.config.cli[ai].command;
    const env = this.env();
    if (!(await findExecutable(command, env))) return { available: false, version: '' };
    const result = await captureCommand({ command, args: ['--version'], env, timeoutMs: 10_000 });
    return { available: true, version: result.ok ? /\b\d+\.\d+\.\d+\b/.exec(result.stdout + '\n' + result.stderr)?.[0] ?? '' : '' };
  }
  private async localModels(ai: CatalogAi): Promise<ModelInfo[]> {
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
