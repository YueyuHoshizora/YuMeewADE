import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './workspace.ts';
import type { ProjectLedger } from './projects.ts';
import type { TaskLedger } from './tasks.ts';
import type { WorktreeService } from '../git/worktree.ts';
import type { ArchiveEntry, ArchivePreview } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { isInside, pathExists, withFileLocks } from '../shared/fsx.ts';
import { parseFrontmatter } from '../shared/frontmatter.ts';
import { isValidProjectName, isValidTaskId } from '../shared/names.ts';
import { git, gitOk, isLocalSecret } from '../git/git.ts';

export class ArchiveService {
  private readonly ws: Workspace;
  private readonly projects: ProjectLedger;
  private readonly tasks: TaskLedger;
  private readonly worktree: WorktreeService;
  private readonly beforeRevive: ((project: string) => Promise<void>) | undefined;
  constructor(ws: Workspace, projects: ProjectLedger, tasks: TaskLedger, worktree: WorktreeService, beforeRevive?: (project: string) => Promise<void>) {
    this.ws = ws; this.projects = projects; this.tasks = tasks; this.worktree = worktree; this.beforeRevive = beforeRevive;
  }
  private root(project?: string): string { return project ? path.join(this.ws.projectDir(project), '.ai', 'trash') : path.join(this.ws.projectsDir, '.trash'); }
  private async safe(root: string, key: string): Promise<string> {
    if (!/^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*-[a-z0-9]+$/u.test(key) || key.includes('..')) throw new AppError('bad_request', 'archive_unsafe_path');
    const dir = path.join(root, key);
    for (let current = root; current !== this.ws.projectsDir; current = path.dirname(current)) {
      if (!isInside(this.ws.projectsDir, current) || (await fs.lstat(current)).isSymbolicLink()) throw new AppError('conflict', 'archive_unsafe_path');
    }
    const real = await fs.realpath(dir);
    if ((await fs.lstat(dir)).isSymbolicLink() || !isInside(await fs.realpath(this.ws.projectsDir), real) || !isInside(await fs.realpath(root), real)) throw new AppError('conflict', 'archive_unsafe_path');
    return dir;
  }
  /** Restored ledger files are later written and read through ordinary paths; a link would redirect those to outside files. */
  private async assertNoLinks(target: string): Promise<void> {
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new AppError('conflict', 'archive_unsafe_path');
    if (stat.isDirectory()) for (const name of await fs.readdir(target)) await this.assertNoLinks(path.join(target, name));
  }
  async list(project?: string): Promise<ArchiveEntry[]> {
    if (project) await this.projects.get(project);
    const root = this.root(project);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const result: ArchiveEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^(.*)-([a-z0-9]+)$/.exec(entry.name);
      if (!match) continue;
      const id = match[1]!;
      if (project ? !isValidTaskId(id) : !isValidProjectName(id)) continue;
      const dir = await this.safe(root, entry.name);
      const file = path.join(dir, project ? `${id}.md` : 'PROJECT.md');
      if ((await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }))?.isSymbolicLink()) throw new AppError('conflict', 'archive_unsafe_path');
      if (!(await pathExists(file))) continue;
      const { data } = parseFrontmatter(await fs.readFile(file, 'utf8'));
      const body = !project && typeof data['body'] === 'string' && path.isAbsolute(data['body']) ? data['body'] : '';
      result.push({ key: entry.name, project: project ?? id, task: project ? id : '', name: String(data[project ? 'title' : 'name'] ?? id), archivedAt: Number.parseInt(match[2]!, 36), ...(body ? { body } : {}) });
    }
    return result.sort((a, b) => b.archivedAt - a.archivedAt);
  }
  async preview(project: string, task?: string): Promise<ArchivePreview> {
    await this.projects.get(project);
    const result: ArchivePreview = { git: [], preserved: [], unavailable: [] };
    for (const record of task ? [await this.tasks.get(project, task)] : await this.tasks.list(project)) {
      const prefix = task ? '' : `${record.id}/`;
      if (record.workspace === 'direct') continue;
      const dir = record.workdir || this.ws.worktreeDir(project, record.id);
      if (!(await pathExists(dir))) continue;
      if (path.resolve(dir) !== this.ws.worktreeDir(project, record.id) || (await fs.lstat(dir)).isSymbolicLink() || (await fs.lstat(path.dirname(dir))).isSymbolicLink() || !isInside(await fs.realpath(this.ws.workDir), await fs.realpath(dir))) { result.unavailable.push(prefix || record.id); continue; }
      const trackedResult = await git(dir, ['ls-files', '-z']);
      const tracked = new Set(trackedResult.code === 0 && !trackedResult.truncated ? trackedResult.stdout.split('\0').filter(Boolean) : []);
      const freshResult = trackedResult.code === 0 ? await gitOk(dir, ['ls-files', '--others', '--exclude-standard', '-z']) : '';
      const fresh = new Set(freshResult.split('\0').filter(Boolean));
      const walk = async (relative: string): Promise<void> => {
        for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
          if (!relative && entry.name === '.git') continue;
          const file = path.join(relative, entry.name);
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile() || entry.isSymbolicLink()) {
            if (entry.isSymbolicLink() && !isInside(dir, path.resolve(path.dirname(path.join(dir, file)), await fs.readlink(path.join(dir, file))))) {
              result.unavailable.push(prefix + file); continue;
            }
            ((tracked.has(file) || (fresh.has(file) && !isLocalSecret(file))) ? result.git : result.preserved).push(prefix + file);
          } else result.unavailable.push(prefix + file);
        }
      };
      await walk('');
    }
    return result;
  }
  async restore(key: string, project?: string): Promise<ArchiveEntry> {
    const entry = (await this.list(project)).find(item => item.key === key);
    if (!entry) throw new AppError('not_found', 'archive_missing');
    const source = await this.safe(this.root(project), key);
    const completedMoves: [string, string][] = [];
    const revived: string[] = [];
    return withFileLocks([this.ws.projectFile(entry.project)], async () => {
      if (!project) {
        const target = this.ws.projectDir(entry.project);
        const taskFiles = await fs.readdir(path.join(source, '.ai', 'tasks')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
        for (const file of taskFiles.filter(name => name.endsWith('.md'))) {
          if (await pathExists(this.ws.worktreeDir(entry.project, file.slice(0, -3)))) throw new AppError('conflict', 'archive_restore_conflict');
        }
        // 先前建立失敗留下的空資料夾不算衝突（與建立專案相同）；有內容就拒絕。
        if (await pathExists(target) && (await fs.readdir(target).catch(() => ['.'])).length === 0) await fs.rmdir(target);
        if (await pathExists(target) || (await this.projects.list()).some(item => item.name.toLowerCase() === entry.name.toLowerCase())) throw new AppError('conflict', 'archive_restore_conflict');
        // External body paths remain untouched; only the ledger directory is moved.
        await this.assertNoLinks(path.join(source, '.ai'));
        await fs.rename(source, target);
        completedMoves.push([source, target]);
      } else {
        if (await pathExists(this.ws.worktreeDir(project, entry.task))) throw new AppError('conflict', 'archive_restore_conflict');
        const moves: [string, string][] = [[path.join(source, `${entry.task}.md`), this.ws.taskFile(project, entry.task)]];
        for (const kind of ['jsonl', 'json', 'queue.json'] as const) {
          const from = path.join(source, `${entry.task}.${kind}`);
          if (await pathExists(from)) moves.push([from, this.ws.chatFile(project, entry.task, kind)]);
        }
        if (await pathExists(path.join(source, 'attachments'))) moves.push([path.join(source, 'attachments'), this.ws.attachmentsDir(project, entry.task)]);
        for (const [from, to] of moves) {
          await this.assertNoLinks(from);
          if (await fs.lstat(to).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; })) throw new AppError('conflict', 'archive_restore_conflict');
        }
        for (const [, to] of moves) {
          for (let current = path.dirname(to); current !== this.ws.projectsDir; current = path.dirname(current)) {
            if (!isInside(this.ws.projectsDir, current)) throw new AppError('conflict', 'archive_unsafe_path');
            const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
            if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new AppError('conflict', 'archive_unsafe_path');
          }
        }
        const moved: [string, string][] = [];
        try {
          for (const [from, to] of moves.slice(1).concat(moves.slice(0, 1))) {
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.rename(from, to); moved.push([from, to]);
          }
        } catch (error) { for (const [from, to] of moved.reverse()) await fs.rename(to, from); throw error; }
        completedMoves.push(...moved);
      }
      return entry;
    }).then(async restored => {
      try {
        const records = project ? [await this.tasks.get(project, entry.task)] : await this.tasks.list(entry.project);
        // The archived ledger must be visible before checking its saved root/policy, but never before checkout.
        if (records.some(record => record.workspace !== 'direct')) await this.beforeRevive?.(entry.project);
        for (const record of records) {
          await this.worktree.revive(entry.project, record.id);
          revived.push(record.id);
        }
        return restored;
      } catch (error) {
        for (const task of revived) if (await this.worktree.exists(entry.project, task)) await this.worktree.abandon(entry.project, task);
        for (const [from, to] of completedMoves.reverse()) await fs.rename(to, from);
        throw error;
      }
    });
  }
}
