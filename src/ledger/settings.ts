import path from 'node:path';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { readJson, updateJson } from '../shared/fsx.ts';
import type { Settings, SettingsPatch } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';

export class SettingsStore {
  private readonly file: string;
  private readonly defaults: Settings;
  constructor(ws: Workspace, config: Config) {
    this.file = path.join(ws.internalDir, 'settings.json');
    this.defaults = { initial: { ai: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, hiddenModels: {}, modelOrder: {}, fullAccess: { claude: config.cli.claude.fullAccess, codex: config.cli.codex.fullAccess } };
  }
  async get(): Promise<Settings> {
    const saved = await readJson<SettingsPatch>(this.file, {});
    return { initial: { ...this.defaults.initial, ...saved.initial }, hiddenModels: saved.hiddenModels ?? {}, modelOrder: saved.modelOrder ?? {}, fullAccess: { ...this.defaults.fullAccess, ...saved.fullAccess } };
  }
  async update(patch: SettingsPatch): Promise<Settings> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError('bad_request', 'field_type');
    if (patch.initial !== undefined && (!patch.initial || typeof patch.initial !== 'object' || !['claude', 'codex'].includes(patch.initial.ai) || typeof patch.initial.model !== 'string' || typeof patch.initial.effort !== 'string')) throw new AppError('bad_request', 'field_type', { field: 'initial' });
    for (const key of ['hiddenModels', 'modelOrder', 'fullAccess'] as const) {
      const value = patch[key]; if (value === undefined) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request', 'field_type', { field: key });
      for (const [ai, item] of Object.entries(value)) {
        if (!['claude', 'codex'].includes(ai) || (key === 'fullAccess' ? typeof item !== 'boolean' : !Array.isArray(item) || item.some(v => typeof v !== 'string'))) throw new AppError('bad_request', 'field_type', { field: key });
      }
    }
    await updateJson<SettingsPatch>(this.file, {}, saved => {
      if (patch.initial !== undefined) saved.initial = { ...patch.initial };
      if (patch.hiddenModels !== undefined) saved.hiddenModels = { ...saved.hiddenModels, ...patch.hiddenModels };
      if (patch.modelOrder !== undefined) saved.modelOrder = { ...saved.modelOrder, ...patch.modelOrder };
      if (patch.fullAccess !== undefined) saved.fullAccess = { ...saved.fullAccess, ...patch.fullAccess };
    });
    return this.get();
  }
}
