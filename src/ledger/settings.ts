import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { readJson, updateJson, withFileLocks, writeJson } from '../shared/fsx.ts';
import type { Settings, SettingsPatch } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';

export class SettingsStore {
  private readonly file: string;
  private readonly defaults: Settings;
  constructor(ws: Workspace, config: Config) {
    this.file = path.join(ws.internalDir, 'settings.json');
    this.defaults = { initial: { ai: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, hiddenModels: {}, modelOrder: {}, fullAccess: { claude: config.cli.claude.fullAccess, codex: config.cli.codex.fullAccess }, accounts: {}, activeAccounts: {} };
  }
  async get(): Promise<Settings> {
    const saved = await readJson<SettingsPatch>(this.file, {});
    return this.merge(saved);
  }
  private merge(saved: SettingsPatch): Settings {
    return { initial: { ...this.defaults.initial, ...saved.initial }, hiddenModels: saved.hiddenModels ?? {}, modelOrder: saved.modelOrder ?? {}, fullAccess: { ...this.defaults.fullAccess, ...saved.fullAccess }, accounts: saved.accounts ?? {}, activeAccounts: saved.activeAccounts ?? {} };
  }
  async update(patch: SettingsPatch): Promise<Settings> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError('bad_request', 'field_type');
    if ('accounts' in patch) throw new AppError('bad_request', 'field_type', { field: 'accounts' });
    if (patch.initial !== undefined && (!patch.initial || typeof patch.initial !== 'object' || !['claude', 'codex'].includes(patch.initial.ai) || typeof patch.initial.model !== 'string' || typeof patch.initial.effort !== 'string')) throw new AppError('bad_request', 'field_type', { field: 'initial' });
    for (const key of ['hiddenModels', 'modelOrder', 'fullAccess'] as const) {
      const value = patch[key]; if (value === undefined) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request', 'field_type', { field: key });
      for (const [ai, item] of Object.entries(value)) {
        if (!['claude', 'codex'].includes(ai) || (key === 'fullAccess' ? typeof item !== 'boolean' : !Array.isArray(item) || item.some(v => typeof v !== 'string'))) throw new AppError('bad_request', 'field_type', { field: key });
      }
    }
    if (patch.activeAccounts !== undefined) {
      if (!patch.activeAccounts || typeof patch.activeAccounts !== 'object' || Array.isArray(patch.activeAccounts)) throw new AppError('bad_request', 'field_type', { field: 'activeAccounts' });
      for (const [ai, id] of Object.entries(patch.activeAccounts)) {
        this.validateAi(ai);
        if (typeof id !== 'string') throw new AppError('bad_request', 'field_type', { field: 'activeAccounts' });
      }
    }
    const saved = await updateJson<SettingsPatch>(this.file, {}, saved => {
      for (const [ai, id] of Object.entries(patch.activeAccounts ?? {})) {
        if (id !== 'default' && !saved.accounts?.[ai]?.some(account => account.id === id)) throw new AppError('not_found');
      }
      if (patch.initial !== undefined) saved.initial = { ...patch.initial };
      if (patch.hiddenModels !== undefined) saved.hiddenModels = { ...saved.hiddenModels, ...patch.hiddenModels };
      if (patch.modelOrder !== undefined) saved.modelOrder = { ...saved.modelOrder, ...patch.modelOrder };
      if (patch.fullAccess !== undefined) saved.fullAccess = { ...saved.fullAccess, ...patch.fullAccess };
      if (patch.activeAccounts !== undefined) saved.activeAccounts = { ...saved.activeAccounts, ...patch.activeAccounts };
    });
    return this.merge(saved);
  }

  private validateAi(ai: string): void {
    if (!['claude', 'codex'].includes(ai)) throw new AppError('bad_request', 'cli_unsupported');
  }

  async addAccount(ai: string, name: string, configDir: string): Promise<Settings> {
    this.validateAi(ai);
    for (const [field, value, max] of [['name', name, 80], ['configDir', configDir, 4096]] as const) {
      if (typeof value !== 'string') throw new AppError('bad_request', 'field_type', { field });
      if (!value.trim()) throw new AppError('bad_request', 'field_required', { field });
      if (value.length > max) throw new AppError('bad_request', 'field_too_long', { field });
    }
    const expanded = configDir === '~' ? os.homedir() : configDir.startsWith('~/') ? path.join(os.homedir(), configDir.slice(2)) : configDir;
    if (!path.isAbsolute(expanded)) throw new AppError('bad_request', 'root_not_absolute');
    if (expanded.length > 4096) throw new AppError('bad_request', 'field_too_long', { field: 'configDir' });
    let canonical: string;
    try {
      canonical = await fs.realpath(expanded);
      if (!(await fs.stat(canonical)).isDirectory()) throw new AppError('bad_request', 'root_not_directory');
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError('bad_request', 'root_not_directory', { cause });
    }
    const saved = await withFileLocks([this.file], async () => {
      const saved = await readJson<SettingsPatch>(this.file, {});
      const accounts = saved.accounts?.[ai] ?? [];
      for (const account of accounts) {
        const existing = await fs.realpath(account.configDir).catch(() => account.configDir);
        if (existing === canonical || account.configDir === expanded) throw new AppError('conflict');
      }
      if (accounts.length >= 10) throw new AppError('unavailable');
      // Claude's Keychain identity uses the configured path, not its realpath.
      saved.accounts = { ...saved.accounts, [ai]: [...accounts, { id: randomUUID(), name: name.trim(), configDir: expanded }] };
      await writeJson(this.file, saved);
      return saved;
    });
    return this.merge(saved);
  }

  async removeAccount(ai: string, id: string): Promise<Settings> {
    this.validateAi(ai);
    if (typeof id !== 'string' || !id) throw new AppError('bad_request', 'field_required', { field: 'id' });
    const saved = await updateJson<SettingsPatch>(this.file, {}, saved => {
      const accounts = saved.accounts?.[ai] ?? [];
      if (!accounts.some(account => account.id === id)) throw new AppError('not_found');
      saved.accounts = { ...saved.accounts, [ai]: accounts.filter(account => account.id !== id) };
      if (saved.activeAccounts?.[ai] === id) saved.activeAccounts = { ...saved.activeAccounts, [ai]: 'default' };
    });
    return this.merge(saved);
  }
}
