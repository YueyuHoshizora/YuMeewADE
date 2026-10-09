// 作業台帳：Projects/{name}/.ai/tasks/{id}.md 的讀寫。更新只改 frontmatter 被動到的鍵，正文與註解保留。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { parseFrontmatter, patchHeaderLines, serializeFrontmatter } from '../shared/frontmatter.ts';
import { atomicWrite } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import { nextTaskId } from '../shared/names.ts';
import { TASK_STATES, type Task, type TaskPatch, type TaskState } from '../shared/types.ts';
import { YamlError, type YamlMap, type YamlValue } from '../shared/yaml.ts';
import { TEMPLATES_DIR, type Workspace } from './workspace.ts';

export function nowMinute(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

const STR_FIELDS = ['title', 'phase', 'owner', 'role', 'cli', 'model', 'effort', 'question'] as const;

/** 「## 步驟」段落內的勾選框進度。 */
export function countSteps(body: string): { done: number; total: number } {
  let inSteps = false;
  let done = 0;
  let total = 0;
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      inSteps = /^##\s*(步驟|手順|Steps)/i.test(line);
      continue;
    }
    if (!inSteps) continue;
    const m = /^\s*[-*]\s*\[([ xX])\]/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

function taskFromData(id: string, data: YamlMap, body: string): Task {
  const s = (k: string) => (data[k] === null || data[k] === undefined ? '' : String(data[k]));
  const state = s('state');
  return {
    id,
    title: s('title'),
    state: TASK_STATES.includes(state as TaskState) ? (state as TaskState) : '未開始',
    phase: s('phase'),
    owner: s('owner'),
    role: s('role'),
    cli: s('cli'),
    model: s('model'),
    effort: s('effort'),
    question: s('question'),
    updated: s('updated'),
    steps: countSteps(body),
  };
}

export class TaskLedger {
  private readonly ws: Workspace;
  constructor(ws: Workspace) {
    this.ws = ws;
  }

  async list(project: string): Promise<Task[]> {
    const dir = this.ws.tasksDir(project);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Task[] = [];
    for (const n of names) {
      if (!n.endsWith('.md') || n.startsWith('_') || n.startsWith('.')) continue;
      const id = n.slice(0, -3);
      try {
        out.push(await this.get(project, id));
      } catch (err) {
        log.warn('略過無法解析的作業', { project, id, reason: err instanceof YamlError ? err.message : 'bad' });
      }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  async get(project: string, id: string): Promise<Task> {
    const text = await this.readRaw(project, id);
    const fm = parseFrontmatter(text);
    return taskFromData(id, fm.data, fm.body);
  }

  /** 原始檔案內容（給提示組裝用）。 */
  async readRaw(project: string, id: string): Promise<string> {
    try {
      return await fs.readFile(this.ws.taskFile(project, id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found', '作業不存在');
      throw err;
    }
  }

  async create(project: string, title: string, role = ''): Promise<Task> {
    const dir = this.ws.tasksDir(project);
    const existing = (await this.list(project)).map((t) => t.id);
    const id = nextTaskId(existing);
    const template = await fs.readFile(path.join(TEMPLATES_DIR, 'task.md'), 'utf8');
    const fm = parseFrontmatter(template);
    const lines = patchHeaderLines(fm.headerLines, { id, title, role, updated: nowMinute() });
    await atomicWrite(path.join(dir, `${id}.md`), serializeFrontmatter(lines, fm.body));
    return this.get(project, id);
  }

  async update(project: string, id: string, patch: TaskPatch): Promise<Task> {
    const text = await this.readRaw(project, id);
    const fm = parseFrontmatter(text);
    const values: Record<string, YamlValue> = {};
    for (const k of STR_FIELDS) {
      const v = patch[k];
      if (v === undefined) continue;
      if (typeof v !== 'string' || v.length > 2000) throw new AppError('bad_request', `${k} 必須是字串`);
      values[k] = v === '' ? null : v;
    }
    if (patch.state !== undefined) {
      if (!TASK_STATES.includes(patch.state)) throw new AppError('bad_request', '狀態值不合法');
      values['state'] = patch.state;
    }
    if (patch.title === '') throw new AppError('bad_request', '標題不得為空');
    if (Object.keys(values).length === 0) throw new AppError('bad_request', '沒有可更新的欄位');
    values['updated'] = nowMinute();
    const lines = patchHeaderLines(fm.headerLines, values);
    await atomicWrite(this.ws.taskFile(project, id), serializeFrontmatter(lines, fm.body));
    return this.get(project, id);
  }
}
