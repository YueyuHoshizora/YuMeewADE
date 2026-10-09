// 專案台帳：Projects/{name}/PROJECT.md 的讀寫。

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { parseFrontmatter, patchHeaderLines, serializeFrontmatter } from '../shared/frontmatter.ts';
import { atomicWrite, pathExists } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import { PROJECT_STATUSES, type Project, type ProjectIssue, type ProjectPatch, type ProjectStatus } from '../shared/types.ts';
import { YamlError, type YamlMap, type YamlValue } from '../shared/yaml.ts';
import { TEMPLATES_DIR, type Workspace } from './workspace.ts';

/** 專案 git 本體的 .gitignore；`.ai/` 不進版本控制（PLAN.md A.2）。 */
export const PROJECT_GITIGNORE = ['# YuMeewADE 台帳與對話不進版本控制', '.ai/', '', '# 本機機密', '.env', '.env.*', '!.env.example', '.DS_Store', ''].join('\n');

export function todayDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function projectFromData(name: string, data: YamlMap): Project {
  const status = data['status'];
  const issues: ProjectIssue[] = [];
  if (Array.isArray(data['issues'])) {
    for (const it of data['issues']) {
      if (it && typeof it === 'object' && !Array.isArray(it)) issues.push({ text: String(it['text'] ?? ''), level: String(it['level'] ?? '') });
      else if (typeof it === 'string') issues.push({ text: it, level: '' });
    }
  }
  return {
    name,
    status: PROJECT_STATUSES.includes(status as ProjectStatus) ? (status as ProjectStatus) : '未開始',
    updated: data['updated'] === null || data['updated'] === undefined ? '' : String(data['updated']),
    related: Array.isArray(data['related']) ? data['related'].filter((x): x is string => typeof x === 'string') : [],
    issues,
  };
}

export class ProjectLedger {
  private readonly ws: Workspace;
  constructor(ws: Workspace) {
    this.ws = ws;
  }

  async list(): Promise<Project[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.ws.projectsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Project[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      try {
        out.push(await this.get(e.name));
      } catch (err) {
        if (err instanceof AppError && err.code === 'not_found') continue;
        log.warn('略過無法解析的專案', { name: e.name, reason: err instanceof YamlError ? err.message : 'bad' });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  }

  async get(name: string): Promise<Project> {
    const file = this.ws.projectFile(name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found', '專案不存在');
      throw err;
    }
    return projectFromData(name, parseFrontmatter(text).data);
  }

  async create(name: string): Promise<Project> {
    const dir = this.ws.projectDir(name);
    const lower = name.toLowerCase();
    for (const existing of await this.list()) {
      if (existing.name.toLowerCase() === lower) throw new AppError('conflict', '同名專案已存在');
    }
    if (await pathExists(dir)) throw new AppError('conflict', '同名專案已存在');
    const template = await fs.readFile(path.join(TEMPLATES_DIR, 'PROJECT.md'), 'utf8');
    const content = template.replaceAll('{{name}}', name).replaceAll('{{date}}', todayDate());
    await fs.mkdir(path.join(dir, '.ai', 'tasks'), { recursive: true });
    await fs.mkdir(path.join(dir, '.ai', 'chat'), { recursive: true });
    await atomicWrite(path.join(dir, 'PROJECT.md'), content);
    await atomicWrite(path.join(dir, '.gitignore'), PROJECT_GITIGNORE);
    return this.get(name);
  }

  async update(name: string, patch: ProjectPatch): Promise<Project> {
    const file = this.ws.projectFile(name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found', '專案不存在');
      throw err;
    }
    const values: Record<string, YamlValue> = {};
    if (patch.status !== undefined) {
      if (!PROJECT_STATUSES.includes(patch.status)) throw new AppError('bad_request', '狀態值不合法');
      values['status'] = patch.status;
    }
    if (Object.keys(values).length === 0) throw new AppError('bad_request', '沒有可更新的欄位');
    values['updated'] = todayDate();
    const fm = parseFrontmatter(text);
    await atomicWrite(file, serializeFrontmatter(patchHeaderLines(fm.headerLines, values), fm.body));
    return this.get(name);
  }
}
