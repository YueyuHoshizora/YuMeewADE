// Work/{project}/{task} is a git worktree; only human-triggered merge publishes its changes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import { CompletionStore } from '../ledger/completion.ts';
import { OpLog } from '../ledger/oplog.ts';
import { AppError } from '../shared/errors.ts';
import { pathExists, withFileLocks } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import type { MergePreview, MergeResult, Task } from '../shared/types.ts';
import { branchExists, commitAll, ensureRepo, git, gitOk, isLocalSecret, isRepo } from './git.ts';

export class MergeConflictError extends AppError {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super('conflict', 'merge_conflict');
    this.conflicts = conflicts;
  }
  override toJSON() { return { ...super.toJSON(), conflicts: this.conflicts }; }
}

export class WorktreeService {
  private readonly ws: Workspace;
  private readonly projects: ProjectLedger;
  private readonly tasks: TaskLedger;
  private readonly diffBytes: number;
  constructor(deps: { ws: Workspace; projects: ProjectLedger; tasks: TaskLedger; diffBytes: number }) {
    this.ws = deps.ws;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.diffBytes = deps.diffBytes;
  }
  branch(task: string): string { return `ym/${task}`; }
  async bodyPath(project: string): Promise<string> {
    return (await this.projects.get(project)).body || this.ws.projectDir(project);
  }
  async exists(project: string, task: string): Promise<boolean> {
    const record = await this.tasks.get(project, task);
    if (record.workdir && await pathExists(record.workdir)) return true;
    return pathExists(this.ws.worktreeDir(project, task));
  }
  private async mutate<T>(project: string, change: () => Promise<T>): Promise<T> {
    const repo = await fs.realpath(await this.bodyPath(project));
    return withFileLocks([repo], change);
  }
  async prepare(project: string, task: string): Promise<string> {
    return this.mutate(project, () => this.prepareLocked(project, task));
  }
  private async prepareLocked(project: string, task: string): Promise<string> {
    const record = await this.tasks.get(project, task);
    const repo = await this.bodyPath(project);
    if (record.workspace === 'direct') {
      if (await isRepo(repo)) await commitAll(repo, 'YuMeewADE：開始前儲存');
      return repo;
    }
    const dir = this.ws.worktreeDir(project, task);
    await ensureRepo(repo);
    if (await pathExists(dir)) {
      await this.verifyFamily(repo, dir);
    } else {
      await commitAll(repo, 'YuMeewADE：開始前儲存');
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await gitOk(repo, ['worktree', 'prune']);
      const branch = this.branch(task);
      await gitOk(repo, await branchExists(repo, branch)
        ? ['worktree', 'add', '-q', dir, branch]
        : ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
      await copyLocalSecrets(repo, dir);
    }
    if (record.workdir !== dir) await this.tasks.update(project, task, { workdir: dir });
    return dir;
  }
  private async verifyFamily(repo: string, dir: string): Promise<void> {
    if (!(await pathExists(path.join(dir, '.git')))) throw new AppError('conflict', 'worktree_not_git');
    const common = async (cwd: string) => fs.realpath((await gitOk(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (await common(repo) !== await common(dir)) throw new AppError('conflict', 'worktree_not_git');
  }
  private async copy(project: string, task: string): Promise<{ record: Task; repo: string; dir: string }> {
    const record = await this.tasks.get(project, task);
    return { record, repo: await this.bodyPath(project), dir: record.workdir };
  }
  async preview(project: string, task: string): Promise<MergePreview | null> {
    const { record, repo, dir } = await this.copy(project, task);
    if (!dir || record.mergeExcluded || !(await pathExists(path.join(dir, '.git')))) return null;
    await this.verifyFamily(repo, dir);
    const mainHead = (await gitOk(repo, ['rev-parse', 'HEAD'])).trim();
    const workHead = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
    const base = (await gitOk(repo, ['merge-base', mainHead, workHead])).trim();
    const stat = await gitOk(dir, ['diff', '--shortstat', base]);
    const untracked = splitNull(await gitOk(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(f => !isLocalSecret(f));
    const paths = splitNull(await gitOk(dir, ['diff', '--name-only', '-z', base]));
    const tree = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', mainHead, workHead]);
    if ((tree.code !== 0 && tree.code !== 1) || tree.truncated) throw new AppError('internal', 'git_failed');
    const branch = (await gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const target = (await gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return {
      branch,
      target,
      files: Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0) + untracked.length,
      added: Number(stat.match(/(\d+) insertions?/)?.[1] ?? 0),
      removed: Number(stat.match(/(\d+) deletions?/)?.[1] ?? 0),
      conflict: tree.code === 1,
      conflictPaths: tree.code === 1 ? splitNull(tree.stdout).slice(1) : [],
      paths: [...new Set([...paths, ...untracked])],
      mainDirty: (await gitOk(repo, ['status', '--porcelain'])).length > 0,
    };
  }
  async diff(project: string, task: string): Promise<{ diff: string; truncated: boolean }> {
    const { repo, dir } = await this.copy(project, task);
    if (!dir || !(await pathExists(path.join(dir, '.git')))) throw new AppError('not_found', 'worktree_missing');
    await this.verifyFamily(repo, dir);
    const head = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
    const base = (await gitOk(repo, ['merge-base', 'HEAD', head])).trim();
    const result = await git(dir, ['diff', base], { maxBytes: this.diffBytes });
    if (result.code !== 0) throw new AppError('internal', 'git_failed');
    let diff = result.stdout;
    let truncated = result.truncated ?? false;
    const files = splitNull(await gitOk(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(f => !isLocalSecret(f));
    for (const file of files) {
      if (truncated) break;
      const next = await git(dir, ['diff', '--no-index', '--', '/dev/null', file], { maxBytes: Math.max(0, this.diffBytes - Buffer.byteLength(diff)) });
      if (next.code !== 0 && next.code !== 1) throw new AppError('internal', 'git_failed');
      diff += next.stdout;
      truncated ||= next.truncated ?? false;
    }
    return { diff, truncated };
  }
  async merge(project: string, task: string): Promise<MergeResult> {
    return this.mutate(project, () => this.mergeLocked(project, task));
  }
  private async mergeLocked(project: string, task: string): Promise<MergeResult> {
    const { record, repo, dir } = await this.copy(project, task);
    if (record.mergeExcluded) throw new AppError('conflict', 'merge_excluded');
    if (!dir || !(await pathExists(path.join(dir, '.git')))) {
      if (record.workdir) await this.tasks.update(project, task, { workdir: '' });
      throw new AppError('conflict', 'worktree_missing');
    }
    await this.verifyFamily(repo, dir);
    if (await mergeHead(repo) || await mergeHead(dir)) throw new AppError('conflict', 'merge_in_progress');
    await commitAll(dir, `${record.title}（作業儲存）`);
    await commitAll(repo, '合併前儲存');
    const source = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
    const before = (await gitOk(repo, ['rev-parse', 'HEAD'])).trim();
    const ancestor = await git(repo, ['merge-base', '--is-ancestor', source, 'HEAD']);
    if (ancestor.code !== 0 && ancestor.code !== 1) throw new AppError('internal', 'git_failed');
    const already = ancestor.code === 0;
    if (!already) {
      const merged = await git(repo, ['merge', '--no-ff', '--no-edit', '-m', `合併：${record.title}`, source]);
      if (merged.code !== 0) {
        const ownMerge = await mergeHead(repo) === source && (await gitOk(repo, ['rev-parse', 'HEAD'])).trim() === before;
        const conflicts = splitNull(await gitOk(repo, ['diff', '--name-only', '--diff-filter=U', '-z']));
        if (ownMerge) await gitOk(repo, ['merge', '--abort']);
        if (ownMerge && conflicts.length > 0) {
          await this.tasks.update(project, task, { state: '等待回覆', question: `合併時發生衝突（${conflicts.join('、')}）。請讓 AI 先把主資料夾的最新內容合進副本並解決衝突，再按合併。` });
          throw new MergeConflictError(conflicts);
        }
        throw new AppError('internal', 'git_failed');
      }
    }
    const commit = (await gitOk(repo, ['rev-parse', '--short', 'HEAD'])).trim();
    const status = splitNull(await gitOk(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const leftover: string[] = [];
    for (let i = 0; i < status.length; i++) {
      const entry = status[i]!;
      leftover.push(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i++;
    }
    if (leftover.length === 0) {
      // A concurrent external edit makes the non-force removal fail instead of discarding work.
      await gitOk(repo, ['worktree', 'remove', dir]);
      const branch = this.branch(task);
      if ((await git(repo, ['branch', '-d', branch])).code !== 0) log.warn('分支未刪除，保留', { project, task, branch });
    }
    await this.tasks.update(project, task, { workdir: leftover.length ? dir : '', state: '完成', question: '' });
    await new CompletionStore(this.ws).approve(project, task);
    await this.tasks.appendMemo(project, task, `已合併到主資料夾 ${commit}`);
    await new OpLog(this.ws).record({ action: 'merge', project, task, commit, already });
    return { merged: true, commit, ...(already ? { already: true } : {}), ...(leftover.length ? { leftover } : {}) };
  }
  async exclusion(project: string, task: string, excluded: boolean): Promise<Task> {
    return this.mutate(project, () => this.tasks.update(project, task, { mergeExcluded: excluded }));
  }
  async copyclear(project: string, task: string): Promise<Task> {
    return this.mutate(project, () => this.copyclearLocked(project, task));
  }
  private async copyclearLocked(project: string, task: string): Promise<Task> {
    const record = await this.tasks.get(project, task);
    if (record.workdir && await pathExists(record.workdir)) throw new AppError('conflict', 'worktree_exists');
    return this.tasks.update(project, task, { workdir: '' });
  }
}
function splitNull(value: string): string[] { return value.split('\0').filter(Boolean); }
async function mergeHead(dir: string): Promise<string | null> {
  const result = await git(dir, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
  if (result.code < 0 || result.truncated) throw new AppError('internal', 'git_failed');
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Copy untracked local settings without logging their contents or following symlinks. */
export async function copyLocalSecrets(repo: string, dir: string): Promise<string[]> {
  const tracked = new Set(splitNull(await gitOk(repo, ['ls-files', '-z'])));
  const copied: string[] = [];
  async function visit(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(repo, relative), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.ai' || entry.name === 'node_modules') continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && isLocalSecret(file) && !tracked.has(file)) {
        await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await fs.copyFile(path.join(repo, file), path.join(dir, file));
        copied.push(file);
      }
    }
  }
  await visit('');
  return copied;
}
