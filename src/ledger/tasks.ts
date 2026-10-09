// 更新只改指定 frontmatter 或段落，保留人與 AI 寫下的其他正文。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { parseFrontmatter, patchHeaderLines, serializeFrontmatter } from '../shared/frontmatter.ts';
import { atomicWrite, pathExists, withFileLocks } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import { nextTaskId } from '../shared/names.ts';
import { TASK_STATES, TASK_KINDS, WORKSPACE_MODES, type NewTaskInput, type Step, type Task, type TaskPatch, type TaskState } from '../shared/types.ts';
import type { YamlValue } from '../shared/yaml.ts';
import { TEMPLATES_DIR, type Workspace } from './workspace.ts';

export function nowMinute(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}
const STR_FIELDS = ['title', 'phase', 'role', 'parent', 'cli', 'model', 'effort', 'question', 'workdir'] as const;
const HEADINGS = { steps: /^(步驟|手順|Steps)$/i, memo: /^(備註|メモ|Memo)$/i, next: /^(下一步|次にやること|Next)$/i };

interface BodySection { rows: string[]; start: number; end: number }
function section(body: string, kind: keyof typeof HEADINGS): BodySection {
  const rows = body.split(/\r?\n/);
  const start = rows.findIndex(row => { const m = /^##\s+(.+?)\s*$/.exec(row); return !!m && HEADINGS[kind].test(m[1]!); });
  let end = rows.length;
  if (start >= 0) for (let i = start + 1; i < rows.length; i++) if (/^##\s/.test(rows[i]!)) { end = i; break; }
  return { rows, start, end };
}

export function parseSteps(body: string): Step[] {
  const { rows, start, end } = section(body, 'steps');
  if (start < 0) return [];
  return rows.slice(start + 1, end).flatMap(row => { const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/.exec(row); return m ? [{ text: m[2]!, done: m[1] !== ' ' }] : []; });
}

export class TaskLedger {
  private readonly ws: Workspace;
  // 專案檔的鎖也保護整個目錄封存，避免寫入時重新建立已搬走的目錄。
  constructor(ws: Workspace) { this.ws = ws; }

  async list(project: string): Promise<Task[]> {
    const names = await fs.readdir(this.ws.tasksDir(project)).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return []; throw err; });
    const rows = await Promise.all(names.filter(n => n.endsWith('.md') && !/^[._]/.test(n)).map(async n => {
      try { return await this.get(project, n.slice(0, -3)); } catch { log.warn('略過無法解析的作業', { project, id: n }); return null; }
    }));
    return rows.filter((t): t is Task => t !== null).sort((a, b) => b.id.localeCompare(a.id));
  }

  async get(project: string, id: string): Promise<Task> {
    const { data, body } = parseFrontmatter(await this.readRaw(project, id));
    const s = (k: string) => data[k] == null ? '' : String(data[k]);
    const memo = section(body, 'memo'), next = section(body, 'next');
    const content = (part: BodySection) => part.start < 0 ? [] : part.rows.slice(part.start + 1, part.end).filter(row => row.trim() && !/^\s*<!--/.test(row));
    return { id, title: s('title') || id, state: TASK_STATES.includes(s('state') as TaskState) ? s('state') as TaskState : '未開始', phase: s('phase'), role: s('role'), parent: s('parent'), kind: s('kind') === 'derived' ? 'derived' : 'main', derivedFrom: s('derivedFrom'), workspace: s('workspace') === 'direct' ? 'direct' : 'isolated', cli: s('cli') || s('owner'), model: s('model'), effort: s('effort'), question: s('question'), workdir: s('workdir'), mergeExcluded: data['mergeExcluded'] === true, updated: s('updated'), steps: parseSteps(body), memo: content(memo).at(-1) ?? '', next: content(next)[0] ?? '' };
  }

  async readRaw(project: string, id: string): Promise<string> {
    try { return await fs.readFile(this.ws.taskFile(project, id), 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found', 'task_missing'); throw err; }
  }

  async create(project: string, input: NewTaskInput): Promise<Task> {
    if (typeof input.title !== 'string' || !input.title.trim()) throw new AppError('bad_request', 'title_required');
    if (input.kind !== undefined && !TASK_KINDS.includes(input.kind) || input.workspace !== undefined && !WORKSPACE_MODES.includes(input.workspace)) throw new AppError('bad_request', 'field_type');
    if (input.steps !== undefined && (!Array.isArray(input.steps) || input.steps.some(s => typeof s !== 'string'))) throw new AppError('bad_request', 'field_type', { field: 'steps' });
    for (const key of ['role','phase','parent','derivedFrom','cli','model','effort'] as const) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 2000)) throw new AppError('bad_request', 'field_type', { field: key });
    if (input.parent) await this.get(project, input.parent);
    return withFileLocks([this.ws.projectFile(project)], async () => {
      if (!await pathExists(this.ws.projectFile(project))) throw new AppError('not_found', 'project_missing');
      const reservations = path.join(this.ws.internalDir, 'task-ids', project);
      await fs.mkdir(reservations, { recursive: true });
      const dirs = [this.ws.tasksDir(project), path.join(this.ws.projectDir(project), '.ai', 'chat'), path.join(this.ws.workDir, project), reservations];
      const names = (await Promise.all(dirs.map(dir => fs.readdir(dir).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return []; throw err; })))).flat().map(n => n.replace(/\..*$/, ''));
      let id: string;
      while (true) {
        id = nextTaskId(names);
        try { const handle = await fs.open(path.join(reservations, id), 'wx'); await handle.close(); break; }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; names.push(id); }
      }
      const fm = parseFrontmatter(await fs.readFile(path.join(TEMPLATES_DIR, 'task.md'), 'utf8'));
      const values: Record<string, YamlValue> = { id, title: input.title.trim(), state: '未開始', phase: input.phase ?? '', role: input.role ?? '', parent: input.parent ?? '', kind: input.kind ?? 'main', derivedFrom: input.derivedFrom ?? '', workspace: input.workspace ?? 'isolated', cli: input.cli ?? '', model: input.model ?? '', effort: input.effort ?? '', question: '', workdir: '', mergeExcluded: false, updated: nowMinute() };
      const steps = (input.steps ?? []).map(s => s.replace(/[\r\n]+/g, ' ').trim()).filter(Boolean);
      const part = section(fm.body, 'steps');
      if (part.start >= 0) part.rows.splice(part.start + 1, part.end - part.start - 1, ...steps.map(s => `- [ ] ${s}`), '');
      await atomicWrite(this.ws.taskFile(project, id), serializeFrontmatter(patchHeaderLines(fm.headerLines, values), part.rows.join('\n')));
      return this.get(project, id);
    });
  }

  async update(project: string, id: string, patch: TaskPatch & { workdir?: string; mergeExcluded?: boolean }): Promise<Task> {
    return withFileLocks([this.ws.projectFile(project), this.ws.taskFile(project, id)], async () => {
      const fm = parseFrontmatter(await this.readRaw(project, id));
      const values: Record<string, YamlValue> = {};
      for (const k of STR_FIELDS) {
        const v = patch[k]; if (v === undefined) continue;
        if (typeof v !== 'string' || v.length > 2000) throw new AppError('bad_request', 'field_type', { field: k });
        values[k] = v;
      }
      if (patch.state !== undefined) { if (!TASK_STATES.includes(patch.state)) throw new AppError('bad_request', 'invalid_state'); values['state'] = patch.state; }
      if (patch.mergeExcluded !== undefined) { if (typeof patch.mergeExcluded !== 'boolean') throw new AppError('bad_request', 'field_type'); values['mergeExcluded'] = patch.mergeExcluded; }
      if (patch.title !== undefined && !patch.title.trim()) throw new AppError('bad_request', 'title_required');
      if (patch.parent) { if (patch.parent === id) throw new AppError('bad_request', 'field_type', { field: 'parent' }); await this.get(project, patch.parent); }
      if (!Object.keys(values).length) throw new AppError('bad_request', 'no_updatable_fields');
      values['updated'] = nowMinute();
      await atomicWrite(this.ws.taskFile(project, id), serializeFrontmatter(patchHeaderLines(fm.headerLines, values), fm.body));
      return this.get(project, id);
    });
  }

  private async editSteps(project: string, id: string, change: (rows: string[], indices: number[], start: number, end: number) => void): Promise<Task> {
    return withFileLocks([this.ws.projectFile(project), this.ws.taskFile(project, id)], async () => {
      const fm = parseFrontmatter(await this.readRaw(project, id));
      let part = section(fm.body, 'steps');
      if (part.start < 0) { fm.body += '\n## 步驟\n'; part = section(fm.body, 'steps'); }
      const indices: number[] = [];
      for (let i = part.start + 1; i < part.end; i++) if (/^\s*[-*]\s*\[[ xX]\]\s*.+$/.test(part.rows[i]!)) indices.push(i);
      change(part.rows, indices, part.start, part.end);
      await atomicWrite(this.ws.taskFile(project, id), serializeFrontmatter(patchHeaderLines(fm.headerLines, { updated: nowMinute() }), part.rows.join('\n')));
      return this.get(project, id);
    });
  }
  async setStep(project: string, id: string, index: number, done: boolean): Promise<Task> {
    if (!Number.isInteger(index) || typeof done !== 'boolean') throw new AppError('bad_request', 'field_type');
    return this.editSteps(project, id, (rows, indices) => { const row = indices[index]; if (row === undefined) throw new AppError('bad_request', 'field_type', { field: 'index' }); rows[row] = rows[row]!.replace(/\[[ xX]\]/, done ? '[x]' : '[ ]'); });
  }
  async addStep(project: string, id: string, text: string): Promise<Task> {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new AppError('bad_request', 'field_type', { field: 'add' });
    return this.editSteps(project, id, (rows, _indices, _start, end) => { rows.splice(end, 0, `- [ ] ${text.replace(/[\r\n]+/g, ' ').trim()}`); });
  }
  async removeStep(project: string, id: string, index: number): Promise<Task> {
    if (!Number.isInteger(index)) throw new AppError('bad_request', 'field_type');
    return this.editSteps(project, id, (rows, indices) => { const row = indices[index]; if (row === undefined) throw new AppError('bad_request', 'field_type', { field: 'remove' }); rows.splice(row, 1); });
  }
  async appendMemo(project: string, id: string, text: string): Promise<Task> {
    if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new AppError('bad_request', 'field_type', { field: 'text' });
    return withFileLocks([this.ws.projectFile(project), this.ws.taskFile(project, id)], async () => {
      const fm = parseFrontmatter(await this.readRaw(project, id));
      let part = section(fm.body, 'memo');
      if (part.start < 0) { fm.body += '\n## 備註\n'; part = section(fm.body, 'memo'); }
      part.rows.splice(part.end, 0, `- ${nowMinute()} ${text.replace(/[\r\n]+/g, ' ').trim()}`);
      await atomicWrite(this.ws.taskFile(project, id), serializeFrontmatter(patchHeaderLines(fm.headerLines, { updated: nowMinute() }), part.rows.join('\n')));
      return this.get(project, id);
    });
  }
  async archive(project: string, id: string): Promise<void> {
    const files = [this.ws.projectFile(project), this.ws.taskFile(project, id), ...(['jsonl', 'json', 'queue.json'] as const).map(kind => this.ws.chatFile(project, id, kind))];
    await withFileLocks(files, async () => {
      await this.readRaw(project, id);
      const trash = path.join(this.ws.projectDir(project), '.ai', 'trash', `${id}-${Date.now().toString(36)}`);
      await fs.mkdir(trash, { recursive: true });
      await fs.rename(this.ws.taskFile(project, id), path.join(trash, `${id}.md`));
      for (const kind of ['jsonl', 'json', 'queue.json'] as const) {
        const file = this.ws.chatFile(project, id, kind);
        try { await fs.rename(file, path.join(trash, path.basename(file))); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      }
      const attachments = this.ws.attachmentsDir(project, id);
      if (await pathExists(attachments)) await fs.rename(attachments, path.join(trash, 'attachments'));
    });
  }
}
