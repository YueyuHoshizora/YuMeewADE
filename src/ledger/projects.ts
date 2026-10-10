// 台帳與程式本體可分離；顯示改名不搬目錄，避免破壞作業與對話的識別碼。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { parseFrontmatter, patchHeaderLines, serializeFrontmatter } from '../shared/frontmatter.ts';
import { atomicWrite, pathExists, withFileLocks } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import { isValidProjectName } from '../shared/names.ts';
import { PHASE_STATES, PROJECT_STATUSES, type NewProjectInput, type Phase, type Project, type ProjectPatch, type ProjectStatus } from '../shared/types.ts';
import { type YamlValue } from '../shared/yaml.ts';
import { ensureRepo } from '../git/git.ts';
import { TEMPLATES_DIR, type Workspace } from './workspace.ts';

export const RULES_MAX = 20_000;

export const PROJECT_GITIGNORE = ['# 台帳與對話不進版本控制', '.ai/', '', '# 本機機密', '.env', '.env.*', '.npmrc', '.dev.vars*', '.DS_Store', ''].join('\n');
export function todayDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export class ProjectLedger {
  private readonly ws: Workspace;
  constructor(ws: Workspace) { this.ws = ws; }

  async list(): Promise<Project[]> {
    const entries = await fs.readdir(this.ws.projectsDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return []; throw err; });
    const rows = await Promise.all(entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(async e => {
      try { return await this.get(e.name); } catch { log.warn('略過無法解析的專案', { id: e.name }); return null; }
    }));
    return rows.filter((p): p is Project => p !== null).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  }

  async get(id: string): Promise<Project> {
    let text: string;
    try { text = await fs.readFile(this.ws.projectFile(id), 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found', 'project_missing'); throw err; }
    const { data, body } = parseFrontmatter(text);
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
    return { id, name: s('name') || id, status: PROJECT_STATUSES.includes(s('status') as ProjectStatus) ? s('status') as ProjectStatus : '未開始', updated: s('updated'), description: s('description'), parent: s('parent'), body: s('body'), verify: s('verify'), phases, related: Array.isArray(data['related']) ? data['related'].filter((v): v is string => typeof v === 'string') : [], issues,
      notes: body.split(/\r?\n/).filter(line => line.trim() && !/^#\s|^\s*<!--/.test(line)).join('\n') };
  }

  private async validate(patch: ProjectPatch, id?: string): Promise<void> {
    if (patch.name !== undefined && !isValidProjectName(patch.name)) throw new AppError('bad_request', 'invalid_project_name');
    for (const key of ['description', 'parent', 'body'] as const) if (patch[key] !== undefined && typeof patch[key] !== 'string') throw new AppError('bad_request', 'field_type', { field: key });
    if (patch.verify !== undefined) {
      if (typeof patch.verify !== 'string' || /[\r\n\0]/u.test(patch.verify)) throw new AppError('bad_request', 'field_type', { field: 'verify' });
      if (patch.verify.trim().length > 500) throw new AppError('bad_request', 'field_too_long', { field: 'verify' });
    }
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
    if (patch.related !== undefined && (!Array.isArray(patch.related) || patch.related.some(v => typeof v !== 'string'))) throw new AppError('bad_request', 'field_type', { field: 'related' });
    if (patch.phases !== undefined && (!Array.isArray(patch.phases) || patch.phases.length > 12 || patch.phases.some(p => !p || typeof p.name !== 'string' || !p.name.trim() || !PHASE_STATES.includes(p.state)))) throw new AppError('bad_request', 'field_type', { field: 'phases' });
  }

  async create(input: NewProjectInput): Promise<Project> {
    return withFileLocks([this.ws.projectFile(input.name)], async () => {
      const phases = input.phases ?? ['計畫', '實作', '檢查', '收尾'];
      if (!Array.isArray(phases) || phases.some(p => typeof p !== 'string')) throw new AppError('bad_request', 'field_type', { field: 'phases' });
      const patch = { ...input, phases: phases.map((name, i) => ({ name: name.trim(), state: i === 0 ? '進行中' as const : '未開始' as const })) };
      await this.validate(patch, input.name);
      const dir = this.ws.projectDir(input.name);
      if (await pathExists(dir) || (await this.list()).some(p => p.name.toLowerCase() === input.name.toLowerCase())) throw new AppError('conflict', 'project_exists');
      await fs.mkdir(dir, { recursive: false });
      await fs.cp(path.join(TEMPLATES_DIR, 'project'), dir, { recursive: true, force: false });
      await Promise.all(['tasks', 'chat', 'uploads'].map(name => fs.mkdir(path.join(dir, '.ai', name), { recursive: true })));
      const template = parseFrontmatter(await fs.readFile(path.join(TEMPLATES_DIR, 'PROJECT.md'), 'utf8'));
      const values: Record<string, YamlValue> = { name: input.name, status: '進行中', updated: todayDate(), description: input.description ?? '', parent: input.parent ?? '', body: input.body ?? '', verify: input.verify?.trim() ?? '', phases: patch.phases.map(p => ({ ...p })), related: input.related ?? [], issues: [] };
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
    if (patch.phases !== undefined) values['phases'] = patch.phases.map(p => ({ ...p }));
    if (!Object.keys(values).length) throw new AppError('bad_request', 'no_updatable_fields');
    values['updated'] = todayDate();
    await atomicWrite(this.ws.projectFile(id), serializeFrontmatter(patchHeaderLines(fm.headerLines, values), fm.body));
    return this.get(id);
  }

  bodyPath(project: Project): string { return project.body || this.ws.projectDir(project.id); }
  currentPhase(project: Project): string { return project.phases.find(p => p.state !== '完成')?.name ?? ''; }
  async nextPhase(id: string): Promise<Project> {
    return withFileLocks([this.ws.projectFile(id)], async () => {
      const project = await this.get(id);
      const index = project.phases.findIndex(p => p.state !== '完成');
      if (index < 0) return project;
      project.phases[index]!.state = '完成';
      if (project.phases[index + 1]) project.phases[index + 1]!.state = '進行中';
      return this.updateLocked(id, { phases: project.phases, ...(index + 1 === project.phases.length ? { status: '完成' as const } : {}) });
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
      await fs.rename(this.ws.projectDir(id), path.join(trash, `${id}-${Date.now().toString(36)}`));
    });
  }
}
