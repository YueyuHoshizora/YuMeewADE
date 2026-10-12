import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { GitFileDiff, GitConflictView, TaskComparison } from '../shared/git-precision.ts';
import { parseBlame, type BlameLine } from '../shared/git-blame.ts';
import { parseHunks, selectedPatch } from './precision.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { GitWorkbenchStatus, GitWorkbenchFile, GitPullRequestStatus, GitRemote } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { missingAs, withFileLocks } from '../shared/fsx.ts';
import { git, hasCommits, isLocalSecret } from './git.ts';
import { github } from '../cli/github.ts';
import type { GithubFeedbackInput } from '../shared/github.ts';

const split = (text: string) => text.split('\0').filter(Boolean);
const branchName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) && !value.includes('..') && !value.endsWith('/') && !value.endsWith('.lock');
const managementName = (value: string, max: number) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') && !value.includes('//') && value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
const remoteUrl = (value: string) => {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\x00-\x1f\x7f]/u.test(value)) return false;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return ['https:', 'ssh:', 'git:', 'file:'].includes(url.protocol) && (url.protocol === 'file:' ? !!url.pathname && !url.username && !url.password : !!url.hostname);
  } catch { return false; }
};
export class GitWorkbench {
  private readonly deps: { ws: Workspace; projects: ProjectLedger; tasks: TaskLedger; isRunning: (project: string, task: string) => boolean; ghCommand?: string };
  constructor(deps: { ws: Workspace; projects: ProjectLedger; tasks: TaskLedger; isRunning: (project: string, task: string) => boolean; ghCommand?: string }) { this.deps = deps; }
  private async command(root: string, args: string[]): Promise<string> {
    // Stash internally uses magic pathspecs to remove saved untracked files.
    const result = await git(root, args[0] === 'stash' ? args : ['--literal-pathspecs', ...args]);
    if (result.code !== 0 || result.truncated) throw new AppError('conflict', 'git_failed');
    return result.stdout;
  }
  private async location(project: string, task?: string): Promise<{ root: string; main: string }> {
    const record = await this.deps.projects.get(project);
    const main = await fs.realpath(record.body || this.deps.ws.projectDir(project)).catch(missingAs(() => new AppError('not_found', 'project_body_missing')));
    let root = main;
    if (task) {
      const item = await this.deps.tasks.get(project, task);
      if (item.workspace !== 'direct') {
        if (!item.workdir) throw new AppError('not_found', 'worktree_missing');
        // A task copy removed outside the app is the same situation as one that was never created.
        root = await fs.realpath(item.workdir).catch(missingAs(() => new AppError('not_found', 'worktree_missing')));
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
    // Status must not rewrite index stat-cache metadata between fingerprint validation and patch application.
    const records = split(await this.command(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']));
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
  async remotes(project: string, task?: string): Promise<GitRemote[]> {
    return this.locked(project, task, false, async root => {
      const names = (await this.command(root, ['remote'])).trim().split('\n').filter(Boolean);
      if (names.length > 100) throw new AppError('too_large');
      return Promise.all(names.map(async name => ({
        name,
        fetchUrls: (await this.command(root, ['remote', 'get-url', '--all', name])).trim().split('\n').filter(Boolean),
        pushUrls: (await this.command(root, ['remote', 'get-url', '--push', '--all', name])).trim().split('\n').filter(Boolean),
      })));
    });
  }
  async remote(project: string, task: string | undefined, action: string, name: string, options: { newName?: string; url?: string; push?: boolean; confirmed?: boolean }): Promise<void> {
    if (!managementName(name, 100) || !['add', 'rename', 'set-url', 'remove'].includes(action)) throw new AppError('bad_request');
    if (action === 'rename' && !managementName(options.newName ?? '', 100)) throw new AppError('bad_request');
    if ((action === 'add' || action === 'set-url') && !remoteUrl(options.url ?? '')) throw new AppError('bad_request');
    if (action === 'remove' && options.confirmed !== true) throw new AppError('bad_request', 'git_confirm_required');
    return this.locked(project, task, true, async root => {
      await this.command(root, ['remote', action, ...(action === 'set-url' && options.push ? ['--push'] : []), name, ...(action === 'rename' ? [options.newName!] : action === 'add' || action === 'set-url' ? [options.url!] : [])]);
    });
  }
  async manageBranch(project: string, task: string | undefined, action: string, name: string, options: { newName?: string; force?: boolean; confirmed?: boolean; forceConfirmed?: boolean }): Promise<void> {
    if (!managementName(name, 200) || !['rename', 'delete'].includes(action) || action === 'rename' && !managementName(options.newName ?? '', 200)) throw new AppError('bad_request', 'git_branch_invalid');
    if (action === 'delete' && (options.confirmed !== true || options.force && options.forceConfirmed !== true)) throw new AppError('bad_request', 'git_confirm_required');
    return this.locked(project, task, true, async root => {
      // Live task names are ledger-owned: renaming would sever the same ownership as deletion.
      if ((await this.deps.tasks.list(project)).some(item => name === `ym/${item.id}`)) throw new AppError('conflict', 'git_workbench_path');
      await this.command(root, ['show-ref', '--verify', `refs/heads/${name}`]);
      if (action === 'delete') {
        const current = (await this.command(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
        if (name === current) throw new AppError('conflict', 'git_workbench_path');
        await this.command(root, ['branch', options.force ? '-D' : '-d', '--', name]);
      } else {
        if ((await this.deps.tasks.list(project)).some(item => options.newName === `ym/${item.id}`)) throw new AppError('conflict', 'git_workbench_path');
        await this.command(root, ['branch', '-m', '--', name, options.newName!]);
      }
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
  async history(project: string, task: string | undefined, skip = 0, relative?: string): Promise<{ graph: string; next: number | null }> {
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > 100_000) throw new AppError('bad_request');
    return this.locked(project, task, false, async root => {
      if (relative) await this.safePath(root, relative);
      if (!await hasCommits(root)) return { graph: '', next: null };
      const graph = await this.command(root, ['log', '--graph', '--date=iso-strict', '--format=%H %P%n%an <%ae> %ad%n%s', '--max-count=51', `--skip=${skip}`, ...(relative ? ['--follow', '--', relative] : [])]);
      const count = Number((await this.command(root, ['rev-list', '--count', 'HEAD', ...(relative ? ['--', relative] : [])])).trim());
      return { graph, next: skip + 51 < count ? skip + 51 : null };
    });
  }
  async commitDetail(project: string, task: string | undefined, sha: string): Promise<{ metadata: string; files: string[]; patch: string }> {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new AppError('bad_request');
    return this.locked(project, task, false, async root => {
      const files = split(await this.command(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha]));
      const safe = files.filter(file => !isLocalSecret(file));
      return { metadata: await this.command(root, ['show', '-s', '--format=fuller', sha]), files: safe, patch: safe.length ? await this.command(root, ['show', '--format=', sha, '--', ...safe]) : '' };
    });
  }
  async blame(project: string, task: string | undefined, relative: string): Promise<BlameLine[]> {
    return this.locked(project, task, false, async root => {
      await this.safePath(root, relative);
      return parseBlame(await this.command(root, ['blame', '--line-porcelain', '--', relative]));
    });
  }
  async stashes(project: string, task?: string): Promise<Array<{ sha: string; ref: string; message: string }>> {
    return this.locked(project, task, false, root => this.stashEntries(root));
  }
  private async stashEntries(root: string): Promise<Array<{ sha: string; ref: string; message: string }>> {
    const records = split(await this.command(root, ['stash', 'list', '--max-count=100', '--format=%H%x00%gd%x00%gs%x00']));
    const entries = [];
    for (let i = 0; i + 2 < records.length; i += 3) entries.push({ sha: records[i]!.trim(), ref: records[i + 1]!, message: records[i + 2]! });
    return entries;
  }
  async stash(project: string, task: string | undefined, action: string, options: { sha?: string; message?: string; includeUntracked?: boolean; confirmed?: boolean }): Promise<void> {
    if (!['push', 'apply', 'pop', 'drop'].includes(action)) throw new AppError('bad_request');
    if (action === 'drop' && !options.confirmed) throw new AppError('bad_request', 'git_confirm_required');
    return this.locked(project, task, true, async root => {
      if (action === 'push') {
        const message = options.message ?? '';
        if (!message.trim() || message.length > 10_000 || message.includes('\0')) throw new AppError('bad_request', 'git_commit_message');
        await this.command(root, ['stash', 'push', ...(options.includeUntracked ? ['--include-untracked'] : []), '-m', message]);
      } else {
        const entry = (await this.stashEntries(root)).find(item => item.sha === options.sha);
        if (!entry) throw new AppError('conflict', 'git_workbench_path');
        await this.command(root, ['stash', action, entry.ref]);
      }
    });
  }
  async rewrite(project: string, task: string | undefined, action: string, target: string, confirmed: boolean): Promise<{ conflicts: boolean }> {
    if (!['cherry-pick', 'rebase', 'continue', 'abort'].includes(action)) throw new AppError('bad_request');
    if (!confirmed) throw new AppError('bad_request', 'git_confirm_required');
    return this.locked(project, task, true, async root => {
      const active = await Promise.all(['rebase-merge', 'rebase-apply'].map(async name => fs.stat((await this.command(root, ['rev-parse', '--path-format=absolute', '--git-path', name])).trim()).then(() => true, () => false)));
      if (action === 'continue' || action === 'abort') {
        if (!active.some(Boolean)) throw new AppError('conflict', 'git_workbench_path');
      } else {
        if (active.some(Boolean) || (await this.files(root)).length) throw new AppError('conflict', 'git_workbench_path');
        if (action === 'cherry-pick' ? !/^[a-f0-9]{40,64}$/.test(target) : !branchName(target)) throw new AppError('bad_request', 'git_branch_invalid');
        if (action === 'rebase') await this.command(root, ['show-ref', '--verify', `refs/heads/${target}`]);
      }
      const result = await git(root, ['-c', 'core.editor=true', '-c', 'sequence.editor=true', action === 'cherry-pick' ? 'cherry-pick' : 'rebase', ...(action === 'continue' || action === 'abort' ? [`--${action}`] : [target])]);
      if (result.code !== 0 || result.truncated) {
        if (action === 'cherry-pick') { await this.command(root, ['cherry-pick', '--abort']); throw new AppError('conflict', 'merge_conflict'); }
        if (result.code > 0 && !result.truncated && (await this.files(root)).some(file => file.conflict)) return { conflicts: true };
        throw new AppError('conflict', 'git_failed');
      }
      return { conflicts: false };
    });
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
  private async fingerprint(root: string, relative: string): Promise<string> {
    await this.safePath(root, relative);
    const index = (await this.command(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
    const indexStat = await fs.stat(index).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (indexStat && indexStat.size > 10 * 1024 * 1024) throw new AppError('too_large');
    const hash = createHash('sha256');
    hash.update(await fs.readFile(index).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; }));
    const full = path.join(root, relative);
    const stat = await fs.stat(full).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.size > 1024 * 1024)) throw new AppError('too_large');
    hash.update(stat ? await fs.readFile(full) : 'absent');
    hash.update(await this.command(root, ['rev-parse', '--verify', 'HEAD']).catch(() => 'unborn'));
    return hash.digest('hex');
  }
  private async fileDiff(root: string, relative: string, staged: boolean): Promise<GitFileDiff> {
    await this.safePath(root, relative);
    const before = await this.fingerprint(root, relative).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'too_large') return '';
      throw error;
    });
    if (!before) {
      const untracked = !staged && (await this.files(root)).some(file => file.path === relative && file.untracked);
      const result = await git(root, untracked
        ? ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', relative]
        : ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...(staged ? ['--cached', '-R'] : []), '--', relative], { maxBytes: 1024 * 1024 });
      if (result.code !== 0 && !(untracked && result.code === 1)) throw new AppError('conflict', 'git_failed');
      return { path: relative, staged, fingerprint: '', patch: result.stdout, hunks: [], selectable: false };
    }
    let patch = await this.command(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', ...(staged ? ['--cached', '-R'] : []), '--', relative]);
    if (!staged && !patch && (await this.files(root)).some(file => file.path === relative && file.untracked)) {
      const result = await git(root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', relative], { maxBytes: 2 * 1024 * 1024 });
      if (result.code !== 1 || result.truncated) throw new AppError('conflict', 'git_failed');
      patch = result.stdout;
    }
    if (before !== await this.fingerprint(root, relative)) throw new AppError('conflict', 'git_workbench_path');
    return { path: relative, staged, fingerprint: before, patch, hunks: parseHunks(patch), selectable: patch.includes('@@ ') && !/(?:Binary files|GIT binary patch)/.test(patch) };
  }
  async diff(project: string, task: string | undefined, relative: string, staged: boolean): Promise<GitFileDiff> {
    return this.locked(project, task, false, root => this.fileDiff(root, relative, staged));
  }
  async diffContents(project: string, task: string | undefined, relative: string, mode: string): Promise<{ before: string; after: string; truncated: boolean; binary: boolean }> {
    if (!['working', 'staged', 'copy'].includes(mode) || mode === 'copy' && !task || relative.length > 1000) throw new AppError('bad_request');
    return this.locked(project, task, false, async root => {
      await this.safePath(root, relative);
      const cap = 1024 * 1024;
      let truncated = false;
      const blob = async (ref: string | null): Promise<string> => {
        const entries = split(await this.command(root, ref === null ? ['ls-files', '--stage', '-z', '--', relative] : ['ls-tree', '-z', ref, '--', relative]));
        const entry = entries.find(item => item.slice(item.indexOf('\t') + 1) === relative && (ref !== null || /^[0-9]+ [a-f0-9]+ 0\t/.test(item)));
        if (!entry) return '';
        const match = /^(\d+) (?:blob )?([a-f0-9]+)/.exec(entry);
        if (!match || !['100644', '100755'].includes(match[1]!)) throw new AppError('forbidden', 'git_workbench_path');
        const size = Number((await this.command(root, ['cat-file', '-s', match[2]!])).trim());
        if (size > cap) { truncated = true; return ''; }
        const result = await git(root, ['cat-file', 'blob', match[2]!], { maxBytes: cap });
        if (result.truncated) { truncated = true; return ''; }
        if (result.code !== 0) throw new AppError('conflict', 'git_failed');
        return result.stdout;
      };
      const working = async (): Promise<string> => {
        const handle = await fs.open(path.join(root, relative), 'r').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!handle) return '';
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new AppError('forbidden', 'git_workbench_path');
          if (stat.size > cap) { truncated = true; return ''; }
          const buffer = Buffer.alloc(cap + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > cap) { truncated = true; return ''; }
          return buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await handle.close(); }
      };
      let before: string; let after: string;
      if (mode === 'staged') {
        before = await blob(null); after = await hasCommits(root) ? await blob('HEAD') : '';
      } else if (mode === 'copy') {
        const { main } = await this.location(project, task);
        const head = (await this.command(root, ['rev-parse', 'HEAD'])).trim();
        const base = (await this.command(main, ['merge-base', 'HEAD', head])).trim();
        before = await blob(base); after = await working();
      } else { before = await blob(null); after = await working(); }
      const binary = before.includes('\0') || after.includes('\0');
      return { before: truncated || binary ? '' : before, after: truncated || binary ? '' : after, truncated, binary };
    });
  }
  async stageLines(project: string, task: string | undefined, relative: string, staged: boolean, fingerprint: string, lines: number[]): Promise<void> {
    return this.locked(project, task, true, async root => {
      const current = await this.fileDiff(root, relative, staged);
      if (current.fingerprint !== fingerprint || !current.selectable || (await this.files(root)).some(file => file.path === relative && file.conflict)) throw new AppError('conflict', 'git_workbench_path');
      const patch = selectedPatch(current.patch, lines);
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'yumeewade-patch-'));
      try {
        const patchFile = path.join(temp, 'patch');
        await fs.writeFile(patchFile, patch, { mode: 0o600 });
        await this.command(root, ['apply', '--cached', '--check', '--', patchFile]);
        if (current.fingerprint !== await this.fingerprint(root, relative)) throw new AppError('conflict', 'git_workbench_path');
        await this.command(root, ['apply', '--cached', '--', patchFile]);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    });
  }
  async conflict(project: string, task: string | undefined, relative: string): Promise<GitConflictView> {
    return this.locked(project, task, false, async root => {
      await this.safePath(root, relative);
      const entries = split(await this.command(root, ['ls-files', '--unmerged', '-z', '--', relative]));
      if (!entries.length) throw new AppError('conflict', 'git_workbench_path');
      const contents = new Map<number, string>();
      for (const entry of entries) {
        const match = /^(\d+) ([a-f0-9]+) ([123])\t/.exec(entry);
        if (!match || match[1] === '120000' || match[1] === '160000') throw new AppError('forbidden', 'git_workbench_path');
        const size = Number((await this.command(root, ['cat-file', '-s', match[2]!])).trim());
        if (size > 1024 * 1024) throw new AppError('too_large');
        const content = await this.command(root, ['cat-file', 'blob', match[2]!]);
        if (content.includes('\0')) throw new AppError('conflict', 'git_workbench_path');
        contents.set(Number(match[3]), content);
      }
      return { path: relative, base: contents.get(1) ?? null, ours: contents.get(2) ?? null, theirs: contents.get(3) ?? null };
    });
  }
  async compareTasks(project: string, leftTask: string, rightTask: string): Promise<TaskComparison> {
    if (leftTask === rightTask) throw new AppError('bad_request', 'git_workbench_path');
    return this.locked(project, undefined, false, async () => {
      const left = (await this.location(project, leftTask)).root;
      const right = (await this.location(project, rightTask)).root;
      const leftBranch = (await this.command(left, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const rightBranch = (await this.command(right, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const paths = new Set([...split(await this.command(left, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])), ...split(await this.command(right, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))]);
      if (paths.size > 5000) throw new AppError('too_large');
      const files: TaskComparison['files'] = []; let bytes = 0; let inputBytes = 0;
      for (const relative of paths) {
        if (isLocalSecret(relative)) continue;
        await this.safePath(left, relative); await this.safePath(right, relative);
        const content = async (root: string) => {
          const full = path.join(root, relative);
          const stat = await fs.stat(full).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
          if (stat && (!stat.isFile() || stat.size > 1024 * 1024)) throw new AppError('too_large');
          inputBytes += stat?.size ?? 0;
          if (inputBytes > 32 * 1024 * 1024) throw new AppError('too_large');
          return stat ? await fs.readFile(full) : null;
        };
        const a = await content(left); const b = await content(right);
        if (a === null && b === null || a !== null && b !== null && a.equals(b)) continue;
        if (files.length >= 100) throw new AppError('too_large');
        const result = await git(left, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', a === null ? '/dev/null' : path.join(left, relative), b === null ? '/dev/null' : path.join(right, relative)], { maxBytes: 1024 * 1024 });
        if (result.truncated || result.code !== 1) throw new AppError('conflict', 'git_failed');
        bytes += Buffer.byteLength(result.stdout);
        if (bytes > 2 * 1024 * 1024) throw new AppError('too_large');
        files.push({ path: relative, patch: result.stdout.split('\n').map(line => /^(?:diff --git |--- |\+\+\+ |Binary files )/.test(line) ? line.replaceAll(left, 'left').replaceAll(right, 'right') : line).join('\n') });
      }
      return { leftTask, rightTask, leftBranch, rightBranch, files };
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
  async commit(project: string, task: string | undefined, message: string, options: { bypassHooks?: boolean; confirmed?: boolean } = {}): Promise<{ sha: string }> {
    if (!message.trim() || message.length > 10_000 || message.includes('\0')) throw new AppError('bad_request', 'git_commit_message');
    if (options.bypassHooks && !options.confirmed) throw new AppError('bad_request', 'git_confirm_required');
    return this.locked(project, task, true, async root => {
      const files = await this.files(root);
      if (files.some(file => file.conflict)) throw new AppError('conflict', 'merge_conflict');
      if (files.some(file => file.staged && file.secret) || split(await this.command(root, ['diff', '--cached', '--name-only', '-z'])).some(isLocalSecret)) throw new AppError('forbidden', 'git_workbench_secret');
      if (!files.some(file => file.staged)) throw new AppError('conflict', 'git_nothing_staged');
      await this.command(root, [...(options.bypassHooks ? ['-c', 'core.hooksPath=/dev/null'] : []), 'commit', ...(options.bypassHooks ? ['--no-verify'] : []), '-m', message]);
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
  private async validateRemote(root: string, name: string): Promise<void> {
    if (!managementName(name, 100) || !(await this.command(root, ['remote'])).split('\n').includes(name)) throw new AppError('bad_request', 'git_remote_invalid');
  }
  async fetch(project: string, task: string | undefined, remote: string): Promise<void> {
    return this.locked(project, task, true, async root => { await this.validateRemote(root, remote); await this.command(root, ['fetch', '--', remote]); });
  }
  async push(project: string, task: string | undefined, remote: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new AppError('bad_request', 'git_confirm_required');
    return this.locked(project, task, true, async root => {
      await this.validateRemote(root, remote);
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
  async pullRequestReview(project: string, task?: string) {
    return this.locked(project, task, false, async root => {
      const branch = (await this.command(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
      return github(root, { action: 'review', branch }, this.deps.ghCommand);
    });
  }
  async issues(project: string, search: string) {
    return this.locked(project, undefined, false, root => github(root, { action: 'issues', search }, this.deps.ghCommand));
  }
  async issue(project: string, number: number) {
    return this.locked(project, undefined, false, root => github(root, { action: 'issue', number }, this.deps.ghCommand));
  }
  async githubFeedback(project: string, input: GithubFeedbackInput) {
    return this.locked(project, undefined, input.action === 'feedback-write', root => github(root, input, this.deps.ghCommand));
  }
}
