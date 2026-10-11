import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { GitWorkbenchStatus, GitWorkbenchFile, GitPullRequestStatus } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { withFileLocks } from '../shared/fsx.ts';
import { git, hasCommits, isLocalSecret } from './git.ts';
import { github } from '../cli/github.ts';

const split = (text: string) => text.split('\0').filter(Boolean);
const branchName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) && !value.includes('..') && !value.endsWith('/') && !value.endsWith('.lock');
export class GitWorkbench {
  private readonly deps: { ws: Workspace; projects: ProjectLedger; tasks: TaskLedger; isRunning: (project: string, task: string) => boolean; ghCommand?: string };
  constructor(deps: { ws: Workspace; projects: ProjectLedger; tasks: TaskLedger; isRunning: (project: string, task: string) => boolean; ghCommand?: string }) { this.deps = deps; }
  private async command(root: string, args: string[]): Promise<string> {
    const result = await git(root, ['--literal-pathspecs', ...args]);
    if (result.code !== 0 || result.truncated) throw new AppError('conflict', 'git_failed');
    return result.stdout;
  }
  private async location(project: string, task?: string): Promise<{ root: string; main: string }> {
    const record = await this.deps.projects.get(project);
    const main = await fs.realpath(record.body || this.deps.ws.projectDir(project));
    let root = main;
    if (task) {
      const item = await this.deps.tasks.get(project, task);
      if (item.workspace !== 'direct') {
        if (!item.workdir) throw new AppError('not_found', 'worktree_missing');
        root = await fs.realpath(item.workdir);
      }
    }
    const common = async (dir: string) => fs.realpath((await this.command(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (await common(root) !== await common(main)) throw new AppError('conflict', 'worktree_not_git');
    if (await fs.realpath((await this.command(root, ['rev-parse', '--show-toplevel'])).trim()) !== root) throw new AppError('conflict', 'worktree_not_git');
    return { root, main };
  }
  private async locked<T>(project: string, task: string | undefined, write: boolean, action: (root: string) => Promise<T>): Promise<T> {
    const { main } = await this.location(project, task);
    return withFileLocks([main], async () => {
      if (write && (await this.deps.tasks.list(project)).some(item => this.deps.isRunning(project, item.id))) throw new AppError('conflict', 'git_workbench_running');
      return action((await this.location(project, task)).root);
    });
  }
  private async files(root: string): Promise<GitWorkbenchFile[]> {
    const records = split(await this.command(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const files: GitWorkbenchFile[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!; const x = record[0]!; const y = record[1]!; const name = record.slice(3);
      const originalPath = x === 'R' || x === 'C' || y === 'R' || y === 'C' ? records[++index] : undefined;
      const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
      files.push({ path: name, ...(originalPath ? { originalPath } : {}), index: x, working: y, staged: x !== ' ' && x !== '?' && !conflict, unstaged: y !== ' ' && y !== '?' && !conflict, untracked: x === '?', conflict, secret: isLocalSecret(name) || !!originalPath && isLocalSecret(originalPath) });
    }
    return files;
  }
  async status(project: string, task?: string): Promise<GitWorkbenchStatus> {
    return this.locked(project, task, false, async root => {
      const branch = (await this.command(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(async () => this.command(root, ['symbolic-ref', '--short', 'HEAD']))).trim();
      const upstreamResult = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : null;
      const counts = upstream ? (await this.command(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/).map(Number) : [0, 0];
      return { root, location: task ? 'task' : 'main', branch, upstream, ahead: counts[0] ?? 0, behind: counts[1] ?? 0, files: await this.files(root), branches: (await this.command(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).trim().split('\n').filter(Boolean), remotes: (await this.command(root, ['remote'])).trim().split('\n').filter(Boolean) };
    });
  }
  private async safePath(root: string, relative: string, allowSecret = false): Promise<void> {
    if (!relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || !allowSecret && isLocalSecret(relative)) throw new AppError('forbidden', 'git_workbench_path');
    let full = root;
    for (const part of relative.split('/')) {
      full = path.join(full, part);
      const stat = await fs.lstat(full).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink()) throw new AppError('forbidden', 'git_workbench_path');
    }
  }
  async stage(project: string, task: string | undefined, relative: string, unstage = false): Promise<void> {
    return this.locked(project, task, true, async root => {
      const file = (await this.files(root)).find(file => file.path === relative);
      if (!file || !unstage && file.secret || file.conflict) throw new AppError('conflict', 'git_workbench_path');
      await this.safePath(root, relative, unstage);
      const paths = [relative, ...(file.originalPath ? [file.originalPath] : [])];
      for (const name of paths) await this.safePath(root, name, unstage);
      await this.command(root, unstage ? await hasCommits(root) ? ['reset', '-q', 'HEAD', '--', ...paths] : ['rm', '--cached', '-q', '--', ...paths] : ['add', '--', ...paths]);
    });
  }
  async resolve(project: string, task: string | undefined, relative: string): Promise<void> {
    return this.locked(project, task, true, async root => {
      if (!(await this.files(root)).some(file => file.path === relative && file.conflict)) throw new AppError('conflict', 'git_workbench_path');
      await this.safePath(root, relative);
      const full = path.join(root, relative);
      const stat = await fs.stat(full).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat) {
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new AppError('too_large');
        const content = await fs.readFile(full, 'utf8');
        if (/^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(content)) throw new AppError('conflict', 'git_conflict_markers');
      }
      await this.command(root, ['add', '--', relative]);
    });
  }
  async commit(project: string, task: string | undefined, message: string): Promise<{ sha: string }> {
    if (!message.trim() || message.length > 10_000 || message.includes('\0')) throw new AppError('bad_request', 'git_commit_message');
    return this.locked(project, task, true, async root => {
      const files = await this.files(root);
      if (files.some(file => file.conflict)) throw new AppError('conflict', 'merge_conflict');
      if (files.some(file => file.staged && file.secret) || split(await this.command(root, ['diff', '--cached', '--name-only', '-z'])).some(isLocalSecret)) throw new AppError('forbidden', 'git_workbench_secret');
      if (!files.some(file => file.staged)) throw new AppError('conflict', 'git_nothing_staged');
      await this.command(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', message]);
      return { sha: (await this.command(root, ['rev-parse', 'HEAD'])).trim() };
    });
  }
  async branch(project: string, task: string | undefined, name: string, create: boolean): Promise<void> {
    if (!branchName(name)) throw new AppError('bad_request', 'git_branch_invalid');
    return this.locked(project, task, true, async root => {
      if ((await git(root, ['check-ref-format', '--branch', name])).code !== 0) throw new AppError('bad_request', 'git_branch_invalid');
      await this.command(root, create ? ['switch', '-c', name] : ['switch', name]);
    });
  }
  private async remote(root: string, name: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || !(await this.command(root, ['remote'])).split('\n').includes(name)) throw new AppError('bad_request', 'git_remote_invalid');
  }
  async fetch(project: string, task: string | undefined, remote: string): Promise<void> {
    return this.locked(project, task, true, async root => { await this.remote(root, remote); await this.command(root, ['fetch', '--', remote]); });
  }
  async push(project: string, task: string | undefined, remote: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new AppError('bad_request', 'git_confirm_required');
    return this.locked(project, task, true, async root => {
      await this.remote(root, remote);
      const branch = (await this.command(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
      if (!branchName(branch)) throw new AppError('bad_request', 'git_branch_invalid');
      await this.command(root, ['push', '--set-upstream', '--', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    });
  }
  async pullRequestStatus(project: string, task?: string): Promise<GitPullRequestStatus> {
    return this.locked(project, task, false, async root => github(root, { action: 'status' }, this.deps.ghCommand));
  }
  async pullRequest(project: string, task: string | undefined, input: { title: string; body: string; base: string; head: string; confirmed: boolean }): Promise<{ url: string }> {
    if (!input.confirmed) throw new AppError('bad_request', 'git_confirm_required');
    if (!input.title.trim() || input.title.length > 300 || input.body.length > 60_000 || !branchName(input.base) || !branchName(input.head)) throw new AppError('bad_request', 'git_pr_invalid');
    return this.locked(project, task, true, async root => github(root, { action: 'create', ...input }, this.deps.ghCommand));
  }
}
