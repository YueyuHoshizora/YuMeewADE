// 台帳與程式本體可分離；顯示改名不搬目錄，避免破壞作業與對話的識別碼。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { parseFrontmatter, patchHeaderLines, serializeFrontmatter } from '../shared/frontmatter.ts';
import { atomicWrite, isInside, pathExists, withFileLocks } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import { isValidProjectName } from '../shared/names.ts';
import { AUTO_FIX_MAX, PHASE_STATES, PROJECT_STATUSES, type NewProjectInput, type Phase, type PhaseState, type Project, type ProjectPatch, type ProjectStatus } from '../shared/types.ts';
import { type YamlValue } from '../shared/yaml.ts';
import { ensureRepo } from '../git/git.ts';
import { parseVerificationChecks, parseVerificationInputModel } from '../shared/verification.ts';
import { TEMPLATES_DIR, type Workspace } from './workspace.ts';

export const RULES_MAX = 20_000;
export const PHASE_NAME_MAX = 200;
export const DESCRIPTION_MAX = 2000;
export const RELATED_MAX = 50;

/** Checked where phases are named (create, edit) rather than in `validate`, so hand-edited ledgers with odd names still advance. */
function checkPhaseNames(names: string[]): void {
  if (names.some(name => !name)) throw new AppError('bad_request', 'field_type', { field: 'phases' });
  if (names.some(name => name.length > PHASE_NAME_MAX)) throw new AppError('bad_request', 'field_too_long', { field: 'phases' });
  // currentPhase and task grouping match phases by name; two equal names would be indistinguishable.
  if (new Set(names).size !== names.length) throw new AppError('bad_request', 'phase_duplicate');
}

export const PROJECT_GITIGNORE = ['# 台帳與對話不進版本控制', '.ai/', '', '# 本機機密', '.env', '.env.*', '.npmrc', '.dev.vars*', '.DS_Store', ''].join('\n');
export function todayDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Electron's fs.cp cannot copy an ASAR directory; read each template through its virtual filesystem.
async function copyProjectTemplate(source: string, destination: string): Promise<void> {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(to, { recursive: true });
      await copyProjectTemplate(from, to);
    } else if (entry.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(from), to);
    } else {
      await atomicWrite(to, await fs.readFile(from));
    }
  }
}

export class ProjectLedger {
  private readonly ws: Workspace;
  constructor(ws: Workspace) { this.ws = ws; }

  /** `skipped` collects the ids of project folders whose PROJECT.md exists but could not be read or parsed. */
  async list(skipped?: string[]): Promise<Project[]> {
    const entries = await fs.readdir(this.ws.projectsDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return []; throw err; });
    const rows = await Promise.all(entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(async e => {
      try { return await this.get(e.name); } catch (err) {
        log.warn('略過無法解析的專案', { id: e.name });
        // Folders that are not projects (no PROJECT.md, e.g. an interrupted create that create() reuses, or a name outside the whitelist) are not broken ledgers.
        if (!(err instanceof AppError && (err.detail === 'project_missing' || err.detail === 'invalid_project_name'))) skipped?.push(e.name);
        return null;
      }
    }));
    return rows.filter((p): p is Project => p !== null).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  }

  async get(id: string): Promise<Project> {
    let text: string;
    try { text = await fs.readFile(this.ws.projectFile(id), 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found', 'project_missing'); throw err; }
    const { data, body } = parseFrontmatter(text);
    const checks = data['checks'] === undefined ? [] : parseVerificationChecks(data['checks']);
    const verificationInputs = parseVerificationInputModel(data['verificationInputs']);
    if (data['requireVerification'] !== undefined && typeof data['requireVerification'] !== 'boolean') throw new AppError('bad_request', 'field_type', { field: 'requireVerification' });
    const s = (key: string) => data[key] == null ? '' : String(data[key]);
    const phases: Phase[] = [];
    if (Array.isArray(data['phases'])) for (const phase of data['phases']) {
      if (phase && typeof phase === 'object' && !Array.isArray(phase) && typeof phase['name'] === 'string') {
        phases.push({ name: phase['name'], state: PHASE_STATES.includes(phase['state'] as Phase['state']) ? phase['state'] as Phase['state'] : '未開始' });
      }
    }
    const issues = (Array.isArray(data['issues']) ? data['issues'] : []).flatMap(it => {
      if (typeof it === 'string') return [{ text: it, level: '' }];
      if (it && typeof it === 'object' && !Array.isArray(it)) return [{ text: String(it['text'] ?? ''), level: String(it['level'] ?? '') }];
      return [];
    });
    return { id, name: s('name') || id, status: PROJECT_STATUSES.includes(s('status') as ProjectStatus) ? s('status') as ProjectStatus : '未開始', updated: s('updated'), description: s('description'), parent: s('parent'), body: s('body'), verify: s('verify') || checks[0]?.command || '', checks, requireVerification: data['requireVerification'] === true, autoFix: typeof data['autoFix'] === 'number' && Number.isInteger(data['autoFix']) ? Math.min(AUTO_FIX_MAX, Math.max(0, data['autoFix'])) : 0, phases, related: Array.isArray(data['related']) ? data['related'].filter((v): v is string => typeof v === 'string') : [], issues,
      verificationInputs,
      notes: body.split(/\r?\n/).filter(line => line.trim() && !/^#\s|^\s*<!--/.test(line)).join('\n') };
  }

  private async validate(patch: ProjectPatch, id?: string): Promise<void> {
    if (patch.name !== undefined && !isValidProjectName(patch.name)) throw new AppError('bad_request', 'invalid_project_name');
    for (const key of ['description', 'parent', 'body'] as const) if (patch[key] !== undefined && typeof patch[key] !== 'string') throw new AppError('bad_request', 'field_type', { field: key });
    if (patch.description !== undefined && patch.description.length > DESCRIPTION_MAX) throw new AppError('bad_request', 'field_too_long', { field: 'description' });
    if (patch.verify !== undefined) {
      if (typeof patch.verify !== 'string' || /[\r\n\0]/u.test(patch.verify)) throw new AppError('bad_request', 'field_type', { field: 'verify' });
      if (patch.verify.trim().length > 500) throw new AppError('bad_request', 'field_too_long', { field: 'verify' });
    }
    if (patch.checks !== undefined) parseVerificationChecks(patch.checks);
    if (patch.verificationInputs !== undefined) parseVerificationInputModel(patch.verificationInputs);
    if (patch.requireVerification !== undefined && typeof patch.requireVerification !== 'boolean') throw new AppError('bad_request', 'field_type', { field: 'requireVerification' });
    if (patch.autoFix !== undefined && (typeof patch.autoFix !== 'number' || !Number.isInteger(patch.autoFix) || patch.autoFix < 0 || patch.autoFix > AUTO_FIX_MAX)) throw new AppError('bad_request', 'field_type', { field: 'autoFix' });
    if (patch.status !== undefined && !PROJECT_STATUSES.includes(patch.status)) throw new AppError('bad_request', 'invalid_state');
    if (patch.body) {
      if (!path.isAbsolute(patch.body) || !(await fs.stat(patch.body).catch(() => null))?.isDirectory()) throw new AppError('bad_request', 'field_type', { field: 'body' });
    }
    if (patch.parent) {
      let parent = await this.get(patch.parent);
      const seen = new Set<string>();
      while (true) {
        if (parent.id === id || seen.has(parent.id)) throw new AppError('bad_request', 'field_type', { field: 'parent' });
        seen.add(parent.id);
        if (!parent.parent) break;
        parent = await this.get(parent.parent);
      }
    }
    if (patch.related !== undefined && (!Array.isArray(patch.related) || patch.related.length > RELATED_MAX || patch.related.some(v => typeof v !== 'string' || !isValidProjectName(v) || v === id) || new Set(patch.related).size !== patch.related.length)) throw new AppError('bad_request', 'field_type', { field: 'related' });
    if (patch.phases !== undefined && (!Array.isArray(patch.phases) || patch.phases.length > 12 || patch.phases.some(p => !p || typeof p.name !== 'string' || !p.name.trim() || !PHASE_STATES.includes(p.state)))) throw new AppError('bad_request', 'field_type', { field: 'phases' });
  }

  async create(input: NewProjectInput): Promise<Project> {
    return withFileLocks([this.ws.projectFile(input.name)], async () => {
      const phases = input.phases ?? ['計畫', '實作', '檢查', '收尾'];
      if (!Array.isArray(phases) || phases.some(p => typeof p !== 'string')) throw new AppError('bad_request', 'field_type', { field: 'phases' });
      const patch = { ...input, phases: phases.map((name, i) => ({ name: name.trim(), state: i === 0 ? '進行中' as const : '未開始' as const })) };
      checkPhaseNames(patch.phases.map(phase => phase.name));
      await this.validate(patch, input.name);
      const dir = this.ws.projectDir(input.name);
      // 先前失敗或中斷的建立會留下空資料夾；它不含任何資料，可直接重用（rmdir 只刪空資料夾）。
      if (await pathExists(dir) && (await fs.readdir(dir).catch(() => ['.'])).length === 0) await fs.rmdir(dir);
      if (await pathExists(dir) || (await this.list()).some(p => p.name.toLowerCase() === input.name.toLowerCase())) throw new AppError('conflict', 'project_exists');
      await fs.mkdir(dir, { recursive: false });
      await copyProjectTemplate(path.join(TEMPLATES_DIR, 'project'), dir);
      await Promise.all(['tasks', 'chat', 'uploads'].map(name => fs.mkdir(path.join(dir, '.ai', name), { recursive: true })));
      const template = parseFrontmatter(await fs.readFile(path.join(TEMPLATES_DIR, 'PROJECT.md'), 'utf8'));
      const values: Record<string, YamlValue> = { name: input.name, status: '進行中', updated: todayDate(), description: input.description ?? '', parent: input.parent ?? '', body: input.body ?? '', verify: input.verify?.trim() || input.checks?.[0]?.command.trim() || '', checks: parseVerificationChecks(input.checks ?? []).map(check => ({ ...check })), requireVerification: input.requireVerification ?? false, phases: patch.phases.map(p => ({ ...p })), related: input.related ?? [], issues: [] };
      const model = parseVerificationInputModel(input.verificationInputs);
      values['verificationInputs'] = { ...(model.inputs ? { inputs: model.inputs } : {}), ...(model.outputs ? { outputs: model.outputs } : {}) };
      await atomicWrite(this.ws.projectFile(input.name), serializeFrontmatter(patchHeaderLines(template.headerLines, values), template.body));
      await atomicWrite(path.join(dir, '.gitignore'), PROJECT_GITIGNORE);
      if (!input.body) await ensureRepo(dir);
      return this.get(input.name);
    });
  }

  async update(id: string, patch: ProjectPatch): Promise<Project> {
    return withFileLocks([this.ws.projectFile(id)], () => this.updateLocked(id, patch));
  }

  private async updateLocked(id: string, patch: ProjectPatch): Promise<Project> {
    await this.get(id);
    await this.validate(patch, id);
    const fm = parseFrontmatter(await fs.readFile(this.ws.projectFile(id), 'utf8'));
    const values: Record<string, YamlValue> = {};
    for (const key of ['name', 'status', 'description', 'parent', 'body', 'related'] as const) if (patch[key] !== undefined) values[key] = patch[key] as YamlValue;
    if (patch.verify !== undefined) values['verify'] = patch.verify.trim();
    if (patch.checks !== undefined) {
      const checks = parseVerificationChecks(patch.checks);
      values['checks'] = checks.map(check => ({ ...check }));
      values['verify'] = checks[0]?.command ?? '';
    } else if (patch.verify !== undefined) {
      values['checks'] = [];
    }
    if (patch.requireVerification !== undefined) values['requireVerification'] = patch.requireVerification;
    if (patch.verificationInputs !== undefined) {
      const model = parseVerificationInputModel(patch.verificationInputs);
      values['verificationInputs'] = { ...(model.inputs ? { inputs: model.inputs } : {}), ...(model.outputs ? { outputs: model.outputs } : {}) };
    }
    if (patch.autoFix !== undefined) values['autoFix'] = patch.autoFix;
    if (patch.phases !== undefined) values['phases'] = patch.phases.map(p => ({ ...p }));
    if (!Object.keys(values).length) throw new AppError('bad_request', 'no_updatable_fields');
    values['updated'] = todayDate();
    await atomicWrite(this.ws.projectFile(id), serializeFrontmatter(patchHeaderLines(fm.headerLines, values), fm.body));
    return this.get(id);
  }

  bodyPath(project: Project): string { return project.body || this.ws.projectDir(project.id); }
  currentPhase(project: Project): string { return project.phases.find(p => p.state !== '完成')?.name ?? ''; }
  /** Completes `expected` and starts the following phase. A stale caller (phase already advanced) gets a conflict instead of skipping a phase. */
  async nextPhase(id: string, expected: string): Promise<Project> {
    return withFileLocks([this.ws.projectFile(id)], async () => {
      const project = await this.get(id);
      if (this.currentPhase(project) !== expected) throw new AppError('conflict', 'phase_changed');
      const index = project.phases.findIndex(p => p.state !== '完成');
      if (index < 0) return project;
      project.phases[index]!.state = '完成';
      if (project.phases[index + 1]) project.phases[index + 1]!.state = '進行中';
      return this.updateLocked(id, { phases: project.phases, ...(index + 1 === project.phases.length ? { status: '完成' as const } : {}) });
    });
  }
  /**
   * Replaces the phase list the caller edited (`previous`, a conflict if it changed meanwhile). An entry's `from` names the
   * existing phase it continues, keeping its state; new entries start unfinished. The first unfinished phase becomes current.
   * Returns the renames so the caller can move tasks along.
   */
  async setPhases(id: string, previous: string[], next: { name: string; from?: string }[]): Promise<{ project: Project; renamed: Map<string, string> }> {
    return withFileLocks([this.ws.projectFile(id)], async () => {
      const project = await this.get(id);
      if (JSON.stringify(project.phases.map(p => p.name)) !== JSON.stringify(previous)) throw new AppError('conflict', 'phase_changed');
      const states = new Map(project.phases.map(p => [p.name, p.state]));
      const sources = next.flatMap(entry => entry.from === undefined ? [] : [entry.from]);
      if (sources.some(from => !states.has(from)) || new Set(sources).size !== sources.length) throw new AppError('bad_request', 'field_type', { field: 'phases' });
      const names = next.map(entry => entry.name.trim());
      checkPhaseNames(names);
      const renamed = new Map<string, string>();
      let started = false;
      const phases: Phase[] = next.map((entry, i) => {
        const name = names[i]!;
        if (entry.from !== undefined && entry.from !== name) renamed.set(entry.from, name);
        let state: PhaseState = entry.from === undefined ? '未開始' : states.get(entry.from)!;
        if (state !== '完成') { state = started ? '未開始' : '進行中'; started = true; }
        return { name, state };
      });
      return { project: await this.updateLocked(id, { phases }), renamed };
    });
  }

  async readRules(id: string): Promise<string> {
    await this.get(id);
    return fs.readFile(this.ws.rulesFile(id), 'utf8').catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return ''; throw err; });
  }

  async writeRules(id: string, text: string): Promise<void> {
    if (text.length > RULES_MAX) throw new AppError('bad_request', 'field_too_long', { field: 'text' });
    await withFileLocks([this.ws.rulesFile(id)], async () => {
      await this.get(id);
      await atomicWrite(this.ws.rulesFile(id), text);
    });
  }

  async archive(id: string): Promise<void> {
    await withFileLocks([this.ws.projectFile(id)], async () => {
      await this.get(id);
      const trash = path.join(this.ws.projectsDir, '.trash');
      await fs.mkdir(trash, { recursive: true });
      if ((await fs.lstat(trash)).isSymbolicLink() || !isInside(await fs.realpath(this.ws.projectsDir), await fs.realpath(trash))) throw new AppError('conflict', 'archive_unsafe_path');
      const target = path.join(trash, `${id}-${Date.now().toString(36)}`);
      if (await pathExists(target)) throw new AppError('conflict', 'archive_restore_conflict');
      await fs.rename(this.ws.projectDir(id), target);
    });
  }
}
