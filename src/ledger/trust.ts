import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectLedger } from './projects.ts';
import type { TaskLedger } from './tasks.ts';
import type { SettingsStore } from './settings.ts';
import type { Workspace } from './workspace.ts';
import type { ProjectTrustPatch, ProjectTrustState, ProjectTrustView } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { readJson, withFileLocks, writeJson } from '../shared/fsx.ts';

const AIS = ['claude', 'codex', 'grok', 'gemini'];
interface SavedTrust { state: ProjectTrustState; root: string; overrides: Partial<Record<string, boolean>> }
export class ProjectTrustService {
  private readonly ws: Workspace;
  private readonly projects: ProjectLedger;
  private readonly tasks: TaskLedger;
  private readonly settings: SettingsStore;
  constructor(ws: Workspace, projects: ProjectLedger, tasks: TaskLedger, settings: SettingsStore) {
    this.ws = ws; this.projects = projects; this.tasks = tasks; this.settings = settings;
  }
  private file(project: string): string { return path.join(this.ws.projectDir(project), '.ai', 'trust.json'); }
  private async policy(project: string): Promise<{ saved: SavedTrust; root: string; revision: string; changed: boolean }> {
    const record = await this.projects.get(project);
    const root = await fs.realpath(this.projects.bodyPath(record));
    const saved = await readJson<SavedTrust>(this.file(project), { state: 'unreviewed', root, overrides: {} });
    if (!saved || !['unreviewed', 'trusted', 'restricted'].includes(saved.state) || typeof saved.root !== 'string' || !saved.overrides || typeof saved.overrides !== 'object' || Array.isArray(saved.overrides) || Object.entries(saved.overrides).some(([ai, value]) => !AIS.includes(ai) || typeof value !== 'boolean')) throw new AppError('conflict', 'project_trust_invalid');
    const revision = createHash('sha256').update(JSON.stringify(saved)).update('\0').update(root).digest('hex');
    return { saved, root, revision, changed: saved.root !== root };
  }
  async view(project: string, task?: string): Promise<ProjectTrustView> {
    const { saved, root, revision, changed } = await this.policy(project);
    const settings = await this.settings.get();
    const state = changed ? 'restricted' : saved.state;
    const fullAccess: Record<string, boolean> = {};
    for (const ai of AIS) fullAccess[ai] = state !== 'restricted' && (state === 'trusted' ? saved.overrides[ai] ?? settings.fullAccess[ai] ?? false : settings.fullAccess[ai] ?? false);
    let cwd = root;
    if (task) {
      const record = await this.tasks.get(project, task);
      if (record.workspace !== 'direct' && record.workdir) cwd = await fs.realpath(record.workdir).catch(() => root);
    }
    return { state, rootChanged: changed, root, cwd, user: os.userInfo().username, revision, fullAccess, overrides: { ...saved.overrides }, additionalDirectories: [path.join(this.ws.projectDir(project), '.ai')], reviewReadonly: true };
  }
  async update(project: string, patch: ProjectTrustPatch): Promise<ProjectTrustView> {
    if (!patch || !['unreviewed', 'trusted', 'restricted'].includes(patch.state) || patch.confirmed !== true || typeof patch.revision !== 'string' || !patch.overrides || typeof patch.overrides !== 'object' || Array.isArray(patch.overrides) || Object.entries(patch.overrides).some(([ai, value]) => !AIS.includes(ai) || typeof value !== 'boolean')) throw new AppError('bad_request', 'project_trust_invalid');
    return withFileLocks([this.file(project)], async () => {
      const current = await this.policy(project);
      if (patch.revision !== current.revision) throw new AppError('conflict', 'project_trust_changed');
      await writeJson(this.file(project), { state: patch.state, root: current.root, overrides: patch.state === 'trusted' ? patch.overrides : {} });
      return this.view(project);
    });
  }
  async assertExecutable(project: string): Promise<void> {
    const { saved, changed } = await this.policy(project);
    if (changed || saved.state === 'restricted') throw new AppError('forbidden', 'project_restricted');
  }
  async fullAccess(project: string, ai: string, inherited: boolean): Promise<boolean> {
    const { saved, changed } = await this.policy(project);
    if (changed || saved.state === 'restricted') throw new AppError('forbidden', 'project_restricted');
    return saved.state === 'trusted' ? saved.overrides[ai] ?? inherited : inherited;
  }
}
