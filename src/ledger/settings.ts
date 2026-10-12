import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { readJson, updateJson, withFileLocks, writeJson } from '../shared/fsx.ts';
import { validEffort, validModelName } from '../shared/ai-pick.ts';
import type { Settings, SettingsPatch } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';

// `accounts` is managed only through the account routes, never by a settings patch.
const SETTINGS_KEYS = new Set(['initial', 'hiddenModels', 'modelOrder', 'fullAccess', 'activeAccounts']);
const MODEL_LIST_MAX = 500;

export class SettingsStore {
  private readonly file: string;
  private readonly defaults: Settings;
  private readonly importCredentials: ((ai: string, directory: string) => Promise<void>) | undefined;
  private readonly loginCredentials: ((ai: string, directory: string) => Promise<void>) | undefined;
  private readonly profileDirectory: ((ai: string) => string) | undefined;
  private readonly activateCredentials: ((ai: string, directory: string | undefined) => Promise<void>) | undefined;
  private readonly forgetCredentials: ((ai: string, directory: string) => Promise<void>) | undefined;
  /** `activateCredentials` copies an account into the App's default slot, or empties the slot when `directory` is undefined. */
  constructor(ws: Workspace, config: Config, importCredentials?: (ai: string, directory: string) => Promise<void>, loginCredentials?: (ai: string, directory: string) => Promise<void>, profileDirectory?: (ai: string) => string, activateCredentials?: (ai: string, directory: string | undefined) => Promise<void>, forgetCredentials?: (ai: string, directory: string) => Promise<void>) {
    this.importCredentials = importCredentials;
    this.loginCredentials = loginCredentials;
    this.profileDirectory = profileDirectory;
    this.activateCredentials = activateCredentials;
    this.forgetCredentials = forgetCredentials;
    this.file = path.join(ws.internalDir, 'settings.json');
    this.defaults = { initial: { ai: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, hiddenModels: {}, modelOrder: {}, fullAccess: { claude: config.cli.claude.fullAccess, codex: config.cli.codex.fullAccess, grok: config.cli.grok.fullAccess, gemini: config.cli.gemini.fullAccess }, accounts: {}, activeAccounts: {} };
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
    // Only known sections are accepted, so nothing else reaches settings.json or the activity log.
    for (const key of Object.keys(patch)) if (!SETTINGS_KEYS.has(key)) throw new AppError('bad_request', 'field_type', { field: key });
    if (patch.initial !== undefined && (!patch.initial || typeof patch.initial !== 'object' || !['claude', 'codex', 'grok', 'gemini'].includes(patch.initial.ai) || !validModelName(patch.initial.model) || !validEffort(patch.initial.effort))) throw new AppError('bad_request', 'field_type', { field: 'initial' });
    for (const key of ['hiddenModels', 'modelOrder', 'fullAccess'] as const) {
      const value = patch[key]; if (value === undefined) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request', 'field_type', { field: key });
      for (const [ai, item] of Object.entries(value)) {
        if (!['claude', 'codex', 'grok', 'gemini'].includes(ai) || (key === 'fullAccess' ? typeof item !== 'boolean' : !Array.isArray(item) || item.length > MODEL_LIST_MAX || !item.every(validModelName))) throw new AppError('bad_request', 'field_type', { field: key });
      }
    }
    if (patch.activeAccounts !== undefined) {
      if (!patch.activeAccounts || typeof patch.activeAccounts !== 'object' || Array.isArray(patch.activeAccounts)) throw new AppError('bad_request', 'field_type', { field: 'activeAccounts' });
      for (const [ai, id] of Object.entries(patch.activeAccounts)) {
        this.validateAi(ai);
        if (typeof id !== 'string') throw new AppError('bad_request', 'field_type', { field: 'activeAccounts' });
      }
    }
    // Switching copies the account's credentials into the App's default slot before the selection is saved. Every selected
    // id is checked first: a patch rejected for one service must not have already switched another service's credentials.
    const current = await this.get();
    const selected = Object.entries(patch.activeAccounts ?? {}).map(([ai, id]) => {
      const account = current.accounts[ai]?.find(entry => entry.id === id);
      if (id !== 'default' && !account) throw new AppError('not_found');
      return [ai, account] as const;
    });
    for (const [ai, account] of selected) {
      if (account && this.activateCredentials) await this.activateCredentials(ai, account.configDir);
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
    if (!['claude', 'codex', 'grok', 'gemini'].includes(ai)) throw new AppError('bad_request', 'cli_unsupported');
  }

  /** An empty private directory for a login the user completes in a terminal (CLIs that cannot log in headlessly). */
  async prepareProfile(ai: string): Promise<string> {
    this.validateAi(ai);
    if (!this.profileDirectory) throw new AppError('unavailable', 'credentials_unavailable');
    const directory = this.profileDirectory(ai);
    try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); }
    catch (cause) { throw new AppError('unavailable', 'credentials_unavailable', { cause }); }
    return directory;
  }

  /** `login` runs the CLI's OAuth login in the directory (created when needed) before importing; without a directory an isolated one is generated. */
  async addAccount(ai: string, name: string, configDir?: string, login = false): Promise<Settings> {
    this.validateAi(ai);
    if (configDir === undefined && login) {
      if (!this.profileDirectory) throw new AppError('unavailable', 'credentials_unavailable');
      configDir = this.profileDirectory(ai);
    }
    for (const [field, value, max] of [['name', name, 80], ['configDir', configDir, 4096]] as const) {
      if (typeof value !== 'string') throw new AppError('bad_request', 'field_type', { field });
      if (!value.trim()) throw new AppError('bad_request', 'field_required', { field });
      if (value.length > max) throw new AppError('bad_request', 'field_too_long', { field });
    }
    configDir = configDir!;
    const expanded = configDir === '~' ? os.homedir() : configDir.startsWith('~/') ? path.join(os.homedir(), configDir.slice(2)) : configDir;
    if (!path.isAbsolute(expanded)) throw new AppError('bad_request', 'root_not_absolute');
    if (expanded.length > 4096) throw new AppError('bad_request', 'field_too_long', { field: 'configDir' });
    if (login && !this.loginCredentials) throw new AppError('unavailable', 'credentials_unavailable');
    let created: string | undefined;
    if (login) {
      try { created = await fs.mkdir(expanded, { recursive: true, mode: 0o700 }); }
      catch (cause) { throw new AppError('bad_request', 'root_not_directory', { cause }); }
    }
    let canonical: string;
    try {
      canonical = await fs.realpath(expanded);
      if (!(await fs.stat(canonical)).isDirectory()) throw new AppError('bad_request', 'root_not_directory');
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError('bad_request', 'root_not_directory', { cause });
    }
    const assertNew = async (accounts: { configDir: string }[]): Promise<void> => {
      for (const account of accounts) {
        const existing = await fs.realpath(account.configDir).catch(() => account.configDir);
        if (existing === canonical || account.configDir === expanded) throw new AppError('conflict');
      }
      if (accounts.length >= 10) throw new AppError('unavailable');
    };
    try {
      if (login) {
        // Run the browser flow outside the settings lock: it can wait for minutes.
        await assertNew((await readJson<SettingsPatch>(this.file, {})).accounts?.[ai] ?? []);
        await this.loginCredentials!(ai, expanded);
      }
      const saved = await withFileLocks([this.file], async () => {
        const saved = await readJson<SettingsPatch>(this.file, {});
        const accounts = saved.accounts?.[ai] ?? [];
        await assertNew(accounts);
        await this.importCredentials?.(ai, expanded);
        // Claude's Keychain identity uses the configured path, not its realpath.
        const account = { id: randomUUID(), name: name.trim(), configDir: expanded };
        if (!accounts.length) {
          await this.activateCredentials?.(ai, expanded);
          saved.activeAccounts = { ...saved.activeAccounts, [ai]: account.id };
        }
        saved.accounts = { ...saved.accounts, [ai]: [...accounts, account] };
        await writeJson(this.file, saved);
        return saved;
      });
      return this.merge(saved);
    } catch (error) {
      // Remove only directories this call created and that the failed login left empty (leaf up to the first created one).
      if (created) for (let dir = path.resolve(expanded); ; dir = path.dirname(dir)) {
        if (!await fs.rmdir(dir).then(() => true, () => false) || dir === path.resolve(created)) break;
      }
      throw error;
    }
  }

  async removeAccount(ai: string, id: string): Promise<Settings> {
    this.validateAi(ai);
    if (typeof id !== 'string' || !id) throw new AppError('bad_request', 'field_required', { field: 'id' });
    let removed: { configDir: string } | undefined;
    const saved = await withFileLocks([this.file], async () => {
      const saved = await readJson<SettingsPatch>(this.file, {});
      const accounts = saved.accounts?.[ai] ?? [];
      removed = accounts.find(account => account.id === id);
      if (!removed) throw new AppError('not_found');
      const remaining = accounts.filter(account => account.id !== id);
      const active = saved.activeAccounts?.[ai];
      if (active === id) {
        // The App's default slot still holds this account's credentials; without a handover every later run would keep
        // using the removed account. Select the next account like a first addition does, or empty the slot.
        let next = remaining[0];
        try { await this.activateCredentials?.(ai, next?.configDir); }
        catch (error) {
          if (!next) throw error;
          next = undefined;
          await this.activateCredentials?.(ai, undefined);
        }
        saved.activeAccounts = { ...saved.activeAccounts, [ai]: next?.id ?? 'default' };
      } else if (!remaining.some(account => account.id === active)) {
        // No registered account owns the slot ('default' selected), so it may still hold the removed account's copy.
        await this.activateCredentials?.(ai, undefined);
      }
      saved.accounts = { ...saved.accounts, [ai]: remaining };
      await writeJson(this.file, saved);
      return saved;
    });
    // Its stored copy would otherwise be reused, unread, if the same folder is added again after a new login there.
    await this.forgetCredentials?.(ai, removed!.configDir);
    return this.merge(saved);
  }
}
