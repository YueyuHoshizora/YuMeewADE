import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, isInside, withFileLocks } from '../shared/fsx.ts';
import { AppError } from '../shared/errors.ts';
import type { LinkedFeedback } from '../shared/github.ts';
import type { Workspace } from './workspace.ts';
import type { TaskLedger } from './tasks.ts';

export class TaskLinkedFeedback {
  constructor(privateWorkspace: Workspace, privateTasks: TaskLedger) { this.ws = privateWorkspace; this.tasks = privateTasks; }
  private readonly ws: Workspace;
  private readonly tasks: TaskLedger;
  private async file(project: string, task: string): Promise<string> {
    await this.tasks.get(project, task);
    const base = await fs.realpath(this.ws.projectDir(project));
    const ai = path.join(base, '.ai');
    if ((await fs.lstat(ai)).isSymbolicLink() || !isInside(base, await fs.realpath(ai))) throw new AppError('forbidden');
    const dir = path.join(ai, 'task-linked-feedback');
    await fs.mkdir(dir, { recursive: true });
    if ((await fs.lstat(dir)).isSymbolicLink() || !isInside(base, await fs.realpath(dir))) throw new AppError('forbidden');
    this.ws.taskFile(project, task);
    const file = path.join(dir, `${task}.json`);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512000)) throw new AppError('conflict');
    return file;
  }
  async get(project: string, task: string): Promise<LinkedFeedback | null> {
    const file = await this.file(project, task);
    try {
      const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('conflict');
      const v = value as Record<string, unknown>;
      for (const key of ['revision', 'repository', 'url', 'threadId', 'commentId', 'path', 'source', 'draft', 'headOid', 'state']) if (typeof v[key] !== 'string') throw new AppError('conflict');
      if (!['thread', 'issue'].includes(v['kind'] as string) || !Number.isSafeInteger(v['number']) || (v['number'] as number) <= 0 || typeof v['resolved'] !== 'boolean' || v['line'] !== null && (!Number.isSafeInteger(v['line']) || (v['line'] as number) <= 0)) throw new AppError('conflict');
      if (v['contentVersion'] !== undefined && (typeof v['contentVersion'] !== 'string' || v['contentVersion'].length > 100)) throw new AppError('conflict');
      return v as unknown as LinkedFeedback;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error instanceof AppError ? error : new AppError('conflict'); }
  }
  async create(project: string, task: string, value: Omit<LinkedFeedback, 'revision'>): Promise<LinkedFeedback> {
    const file = await this.file(project, task);
    return withFileLocks([this.ws.projectFile(project), file], async () => {
      if (await this.get(project, task)) throw new AppError('conflict');
      const result = { ...value, revision: randomUUID() };
      if (result.draft.length > 100000 || Buffer.byteLength(JSON.stringify(result)) > 512000) throw new AppError('too_large');
      await atomicWrite(file, JSON.stringify(result)); return result;
    });
  }
  async change(project: string, task: string, revision: string, change: (value: LinkedFeedback) => Promise<LinkedFeedback>): Promise<LinkedFeedback> {
    const file = await this.file(project, task);
    return withFileLocks([this.ws.projectFile(project), file], async () => {
      const current = await this.get(project, task);
      if (!current || current.revision !== revision) throw new AppError('conflict');
      const updated = { ...await change(current), revision: randomUUID() };
      if (updated.draft.length > 100000 || Buffer.byteLength(JSON.stringify(updated)) > 512000) throw new AppError('too_large');
      await atomicWrite(file, JSON.stringify(updated)); return updated;
    });
  }
}
