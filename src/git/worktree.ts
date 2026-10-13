// Work/{project}/{task} is a git worktree; only human-triggered merge publishes its changes.
import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import { CompletionStore } from '../ledger/completion.ts';
import { ArchiveService } from '../ledger/archive.ts';
import { OpLog } from '../ledger/oplog.ts';
import { AppError } from '../shared/errors.ts';
import { isInside, pathExists, withFileLocks } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import type { FileView, MergePreview, MergeResult, Task, TaskOverlap, TurnChanges, WorktreeMaintenanceEntry } from '../shared/types.ts';
import { branchExists, commitAll, ensureRepo, git, gitOk, isLocalSecret, isRepo, operationInProgress, snapshotCommit } from './git.ts';
import { RecoveryStore } from './recovery.ts';

const SHA = /^[0-9a-f]{40}$/;
const FILE_VIEW_MAX = 256 * 1024;
const MERGE_TRAILER = 'YuMeewADE-Task: ';

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
  /** NUL-delimited porcelain keeps whitespace and newlines in paths unambiguous. */
  async maintenance(project: string): Promise<WorktreeMaintenanceEntry[]> {
    const repo = await this.bodyPath(project);
    if (!(await isRepo(repo))) return [];
    const records = await this.tasks.list(project);
    const archived = await new ArchiveService(this.ws, this.projects, this.tasks, this).list(project);
    const raw = await gitOk(repo, ['worktree', 'list', '--porcelain', '-z']);
    const entries: WorktreeMaintenanceEntry[] = [];
    const realRoot = await fs.realpath(this.ws.root);
    for (const block of raw.split('\0\0').filter(Boolean)) {
      const fields = block.split('\0');
      const listed = fields.find(value => value.startsWith('worktree '))?.slice(9);
      if (!listed) throw new AppError('internal', 'git_failed');
      // Git canonicalizes macOS /var aliases; ledger paths retain the configured root.
      const dir = isInside(realRoot, listed) ? path.join(this.ws.root, path.relative(realRoot, listed)) : listed;
      const resolved = path.resolve(dir);
      // path.relative folds case on Windows, where Git may report a drive letter or folder in another case than the ledger.
      const same = (value: string) => path.relative(path.resolve(value), resolved) === '';
      const task = records.find(record => record.workspace !== 'direct' && [record.workdir, this.ws.worktreeDir(project, record.id)].filter(Boolean).some(same));
      const archivedTask = archived.find(record => same(this.ws.worktreeDir(project, record.task)));
      const main = entries.length === 0 || same(repo);
      const missing = !(await pathExists(dir));
      const locked = fields.some(value => value === 'locked' || value.startsWith('locked '));
      const kind = main ? 'main' : task ? 'active' : archivedTask ? 'archived' : 'orphan';
      const dirty = missing ? null : (await gitOk(dir, ['status', '--porcelain', '--untracked-files=all', '--ignored'])).length > 0;
      const managed = path.relative(path.dirname(resolved), path.join(this.ws.workDir, project)) === '';
      entries.push({ path: dir, branch: fields.find(value => value.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? '', kind, task: task?.id ?? archivedTask?.task ?? '', locked, prunable: missing && !locked, dirty, removable: managed && !main && !task && !missing && !locked && dirty === false });
    }
    return entries;
  }
  async prunePreview(project: string): Promise<string> {
    const result = await git(await this.bodyPath(project), ['worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now']);
    if (result.code !== 0 || result.truncated || result.stderr.length >= 4000) throw new AppError('internal', 'git_failed');
    return result.stdout + result.stderr;
  }
  async pruneStale(project: string, preview: string): Promise<void> {
    await this.mutate(project, async () => {
      const entries = await this.maintenance(project);
      if (entries.some(entry => entry.prunable && (entry.kind === 'active' || entry.kind === 'main'))) throw new AppError('conflict', 'archive_unsafe_path');
      if (await this.prunePreview(project) !== preview) throw new AppError('conflict', 'archive_restore_conflict');
      await gitOk(await this.bodyPath(project), ['worktree', 'prune', '--verbose', '--expire', 'now']);
      await new OpLog(this.ws).record({ action: 'worktree.prune', project });
    });
  }
  async removeStale(project: string, target: string): Promise<void> {
    await this.mutate(project, async () => {
      const entry = (await this.maintenance(project)).find(item => item.path === target);
      if (!entry?.removable) throw new AppError('conflict', 'archive_unsafe_path');
      const parent = await fs.realpath(path.dirname(target));
      if ((await fs.lstat(target)).isSymbolicLink() || (await fs.lstat(path.dirname(target))).isSymbolicLink() || !isInside(await fs.realpath(this.ws.workDir), parent)) throw new AppError('conflict', 'archive_unsafe_path');
      await this.verifyFamily(await this.bodyPath(project), target);
      // Git rechecks cleanliness; never force deletion, even after a clean preview.
      await gitOk(await this.bodyPath(project), ['worktree', 'remove', '--', target]);
      await new OpLog(this.ws).record({ action: 'worktree.remove-stale', project });
    });
  }
  async bodyPath(project: string): Promise<string> {
    return (await this.projects.get(project)).body || this.ws.projectDir(project);
  }
  async exists(project: string, task: string): Promise<boolean> {
    return this.copyExists(project, await this.tasks.get(project, task));
  }
  /** Same check for callers that already hold the task record (avoids re-reading the ledger file). */
  async copyExists(project: string, record: Pick<Task, 'id' | 'workdir'>): Promise<boolean> {
    if (record.workdir && await pathExists(record.workdir)) return true;
    return pathExists(this.ws.worktreeDir(project, record.id));
  }
  private async mutate<T>(project: string, change: () => Promise<T>): Promise<T> {
    const repo = await fs.realpath(await this.bodyPath(project));
    return withFileLocks([repo], change);
  }
  async prepare(project: string, task: string): Promise<string> {
    return this.mutate(project, () => this.prepareLocked(project, task));
  }
  /** 新作業的副本從某個檢查點長出來（分支作業用）；不動主資料夾。 */
  async prepareFrom(project: string, task: string, sha: string): Promise<string> {
    if (!SHA.test(sha)) throw new AppError('not_found', 'checkpoint_missing');
    return this.mutate(project, async () => {
      const known = await git(await this.bodyPath(project), ['cat-file', '-e', `${sha}^{commit}`]);
      if (known.code !== 0) throw new AppError('not_found', 'checkpoint_missing');
      return this.prepareLocked(project, task, sha);
    });
  }
  private async prepareLocked(project: string, task: string, from?: string): Promise<string> {
    const record = await this.tasks.get(project, task);
    const repo = await this.bodyPath(project);
    if (record.workspace === 'direct') {
      // Working directly in the main folder may be how the user resolves an unfinished merge or rebase; skip the save instead of blocking.
      if (await isRepo(repo) && !(await operationInProgress(repo))) await commitAll(repo, 'YuMeewADE：開始前儲存');
      return repo;
    }
    const dir = this.ws.worktreeDir(project, task);
    await ensureRepo(repo);
    if (await pathExists(dir)) {
      await this.verifyFamily(repo, dir);
    } else {
      if (!from) await commitAll(repo, 'YuMeewADE：開始前儲存');
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await gitOk(repo, ['worktree', 'prune']);
      const branch = this.branch(task);
      await gitOk(repo, await branchExists(repo, branch)
        ? ['worktree', 'add', '-q', dir, branch]
        : ['worktree', 'add', '-q', '-b', branch, dir, from ?? 'HEAD']);
      await copyLocalSecrets(repo, dir);
    }
    if (record.workdir !== dir) await this.tasks.update(project, task, { workdir: dir });
    return dir;
  }
  /** 檔案檢視／@ 提及的根：有副本用副本，否則用主資料夾（AI 開始時會看到的內容）。 */
  private async viewRoot(project: string, task: string): Promise<string> {
    if (!task) return this.projects.bodyPath(await this.projects.get(project));
    const { repo, dir } = await this.copy(project, task);
    return dir && await pathExists(path.join(dir, '.git')) ? dir : repo;
  }
  /** 可檢視的檔案（git 追蹤的＋未被忽略的新檔，不含本機機密檔）。 */
  async listFiles(project: string, task: string): Promise<string[]> {
    const root = await this.viewRoot(project, task);
    if (!(await isRepo(root))) return [];
    // `--stage` gives each tracked path's mode, so only symbolic links (120000) need resolving; new files are few and lstat'ed.
    const staged = splitNull(await gitOk(root, ['ls-files', '--stage', '-z'])).map(entry => ({ link: entry.startsWith('120000 '), file: entry.slice(entry.indexOf('\t') + 1) }));
    const fresh = splitNull(await gitOk(root, ['ls-files', '--others', '--exclude-standard', '-z']));
    const base = await fs.realpath(root);
    const links = new Set(staged.filter(entry => entry.link).map(entry => entry.file));
    await Promise.all(fresh.map(async file => { if ((await fs.lstat(path.join(base, file)).catch(() => null))?.isSymbolicLink()) links.add(file); }));
    // A link to a local secret (`settings.txt -> .env.local`) exposes the secret as much as the secret itself.
    const secretLink = async (file: string) => {
      const target = await fs.realpath(path.join(base, file)).catch(() => null);
      return !!target && isInside(base, target) && isLocalSecret(path.relative(base, target));
    };
    const files = [...new Set([...staged.map(entry => entry.file), ...fresh])].filter(file => !isLocalSecret(file));
    const hidden = new Set((await Promise.all([...links].map(async file => await secretLink(file) ? file : null))).filter(file => file !== null));
    return files.filter(file => !hidden.has(file)).sort();
  }
  /** 唯讀取檔：路徑必須在 listFiles 內、解析後仍在根目錄內（擋符號連結逃出）、只取前 FILE_VIEW_MAX 位元組。 */
  async readFile(project: string, task: string, relative: string): Promise<FileView> {
    if (!(await this.listFiles(project, task)).includes(relative)) throw new AppError('not_found', 'file_missing');
    const root = await fs.realpath(await this.viewRoot(project, task));
    const full = await fs.realpath(path.join(root, relative)).catch(() => null);
    if (!full || !isInside(root, full) || isLocalSecret(path.relative(root, full))) throw new AppError('not_found', 'file_missing');
    const handle = await fs.open(full, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AppError('not_found', 'file_missing');
      const buffer = Buffer.alloc(Math.min(stat.size, FILE_VIEW_MAX));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead);
      const binary = head.subarray(0, 8000).includes(0);
      return { path: relative, size: stat.size, truncated: stat.size > FILE_VIEW_MAX, binary, text: binary ? '' : head.toString('utf8') };
    } finally { await handle.close(); }
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
    // The merge first commits pending edits on both sides (commitAll), so the preview is computed on those snapshots:
    // they hold untracked files but not newly added local secrets, even ones staged by hand, which the merge leaves out.
    const [mainSnapshot, workSnapshot] = await Promise.all([snapshotCommit(repo), snapshotCommit(dir)]);
    // --no-renames: a rename is listed as the original's deletion plus the new file, each revertable on its own (revertFile).
    const stat = await gitOk(dir, ['diff', '--shortstat', '--no-renames', base, workSnapshot]);
    const paths = splitNull(await gitOk(dir, ['diff', '--name-only', '--no-renames', '-z', base, workSnapshot]));
    const tree = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', mainSnapshot, workSnapshot]);
    if ((tree.code !== 0 && tree.code !== 1) || tree.truncated) throw new AppError('internal', 'git_failed');
    const branch = (await gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const target = (await gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return {
      branch,
      target,
      files: Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0),
      added: Number(stat.match(/(\d+) insertions?/)?.[1] ?? 0),
      removed: Number(stat.match(/(\d+) deletions?/)?.[1] ?? 0),
      conflict: tree.code === 1,
      conflictPaths: tree.code === 1 ? splitNull(tree.stdout).slice(1) : [],
      paths,
      overlaps: await this.overlaps(project, task, repo, paths),
      mainDirty: (await gitOk(repo, ['status', '--porcelain'])).length > 0,
    };
  }
  /** 同專案其他有副本的作業，與這個作業改到同樣檔案的清單；別人的副本壞了不影響這個作業的預覽。 */
  private async overlaps(project: string, task: string, repo: string, paths: string[]): Promise<TaskOverlap[]> {
    if (paths.length === 0) return [];
    const mine = new Set(paths);
    const found: TaskOverlap[] = [];
    for (const other of await this.tasks.list(project)) {
      if (other.id === task || !other.workdir || other.mergeExcluded) continue;
      try {
        if (!(await pathExists(path.join(other.workdir, '.git')))) continue;
        await this.verifyFamily(repo, other.workdir);
        const base = (await gitOk(repo, ['merge-base', 'HEAD', (await gitOk(other.workdir, ['rev-parse', 'HEAD'])).trim()])).trim();
        const changed = [
          ...splitNull(await gitOk(other.workdir, ['diff', '--name-only', '--no-renames', '-z', base])),
          ...splitNull(await gitOk(other.workdir, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(f => !isLocalSecret(f)),
        ];
        const shared = [...new Set(changed.filter(p => mine.has(p)))];
        if (shared.length > 0) found.push({ task: other.id, title: other.title, paths: shared });
      } catch (err) {
        log.warn('比對其他作業的變更失敗', { project, task: other.id, err: String(err) });
      }
    }
    return found;
  }
  /** 把單一檔案還原成分岔點（合併基準）的樣子：本來就有的檔案取回原內容，新增的檔案刪掉。路徑必須是目前確實有變更的檔案。 */
  async revertFile(project: string, task: string, relative: string): Promise<void> {
    await this.mutate(project, async () => {
      const { repo, dir } = await this.copy(project, task);
      if (!dir || !(await pathExists(path.join(dir, '.git')))) throw new AppError('not_found', 'worktree_missing');
      await this.verifyFamily(repo, dir);
      const head = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
      const base = (await gitOk(repo, ['merge-base', 'HEAD', head])).trim();
      const changed = new Set([
        ...splitNull(await gitOk(dir, ['diff', '--name-only', '--no-renames', '-z', base])),
        ...splitNull(await gitOk(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(file => !isLocalSecret(file)),
      ]);
      if (!changed.has(relative)) throw new AppError('not_found', 'file_missing');
      const existed = (await git(dir, ['cat-file', '-e', `${base}:${relative}`])).code === 0;
      // Literal pathspecs: a file named `file*.txt` (or `:(glob)…`) names itself, not every file the pattern matches.
      if (existed) {
        await gitOk(dir, ['--literal-pathspecs', 'checkout', base, '--', relative]);
        await gitOk(dir, ['--literal-pathspecs', 'reset', '-q', '--', relative]);
      } else if ((await git(dir, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', relative])).code === 0) {
        await gitOk(dir, ['--literal-pathspecs', 'rm', '-f', '-q', '--', relative]);
      } else {
        await fs.rm(path.join(dir, relative), { force: true });
      }
    });
  }
  async diff(project: string, task: string): Promise<{ diff: string; truncated: boolean }> {
    const { repo, dir } = await this.copy(project, task);
    if (!dir || !(await pathExists(path.join(dir, '.git')))) throw new AppError('not_found', 'worktree_missing');
    await this.verifyFamily(repo, dir);
    const head = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
    const base = (await gitOk(repo, ['merge-base', 'HEAD', head])).trim();
    const result = await git(dir, ['diff', '--no-renames', base], { maxBytes: this.diffBytes });
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
  /** 每輪開始前把副本現況存成 commit 並回傳其 sha；直接在主資料夾工作（沒有副本）時回 undefined。 */
  async checkpoint(project: string, task: string): Promise<string | undefined> {
    return this.mutate(project, async () => {
      const { record, dir } = await this.copy(project, task);
      if (record.workspace === 'direct' || !dir || !(await pathExists(path.join(dir, '.git')))) return undefined;
      // The AI may have stopped mid-merge or mid-rebase; the next turn must still start (and can finish it), just without a checkpoint.
      if (await operationInProgress(dir)) return undefined;
      await commitAll(dir, 'YuMeewADE：回合前檢查點');
      return (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
    });
  }
  /** 副本回到檢查點：丟棄之後的 commit 與未提交變更（本機機密檔保留）。 */
  async restore(project: string, task: string, sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new AppError('not_found', 'checkpoint_missing');
    await this.mutate(project, async () => {
      const { repo, dir } = await this.copy(project, task);
      if (!dir || !(await pathExists(path.join(dir, '.git')))) throw new AppError('not_found', 'worktree_missing');
      await this.verifyFamily(repo, dir);
      // The AI may have stopped mid-rebase/merge (the turn then got no checkpoint): end that operation first so the reset
      // lands on the task branch, not a detached rebase HEAD, and later turns get checkpoints again.
      if (await operationInProgress(dir)) {
        const marker = async (name: string) => fs.lstat((await gitOk(dir, ['rev-parse', '--path-format=absolute', '--git-path', name])).trim()).then(() => true, () => false);
        if (await marker('rebase-merge') || await marker('rebase-apply')) await git(dir, [await marker('rebase-apply/applying') ? 'am' : 'rebase', '--abort']);
        for (const [name, command] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) if (await marker(name)) await git(dir, [command, '--abort']);
        if (await marker('rebase-merge') || await marker('rebase-apply')) throw new AppError('conflict', 'git_failed');
      }
      const reachable = await git(dir, ['merge-base', '--is-ancestor', sha, 'HEAD']);
      if (reachable.code !== 0) throw new AppError('not_found', 'checkpoint_missing');
      // reset --hard deletes tracked files the checkpoint lacks, so local secrets added since (even staged or committed by
      // hand) are first dropped from the index only: as untracked files they survive the reset and the clean below.
      const added = splitNull(await gitOk(dir, ['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', sha])).filter(isLocalSecret);
      if (added.length) await gitOk(dir, ['--literal-pathspecs', 'rm', '-q', '--cached', '--', ...added]);
      await gitOk(dir, ['reset', '-q', '--hard', sha]);
      // Exclude patterns are case-sensitive on Linux; local secrets match in any case (see isLocalSecret).
      await gitOk(dir, ['clean', '-fdq', '-e', '.[eE][nN][vV]*', '-e', '.[nN][pP][mM][rR][cC]', '-e', '.[dD][eE][vV].[vV][aA][rR][sS]*']);
    });
  }
  /** 一輪結束：把副本現況存成檢查點，並統計這輪（輪前 start → 現在）改了多少；沒有副本回 undefined。 */
  async finishTurn(project: string, task: string, start: string): Promise<{ after: string; changes?: TurnChanges } | undefined> {
    if (!SHA.test(start)) throw new AppError('not_found', 'checkpoint_missing');
    const after = await this.checkpoint(project, task);
    if (!after) return undefined;
    const { dir } = await this.copy(project, task);
    const stat = await gitOk(dir, ['diff', '--shortstat', start, after]);
    const files = Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0);
    if (!files) return { after };
    return { after, changes: { files, added: Number(stat.match(/(\d+) insertions?/)?.[1] ?? 0), removed: Number(stat.match(/(\d+) deletions?/)?.[1] ?? 0) } };
  }
  /** 兩個檢查點之間的差異（單輪的變更檢視）。 */
  async rangeDiff(project: string, task: string, from: string, to: string): Promise<{ diff: string; truncated: boolean }> {
    if (!SHA.test(from) || !SHA.test(to)) throw new AppError('not_found', 'checkpoint_missing');
    const { repo, dir } = await this.copy(project, task);
    if (!dir || !(await pathExists(path.join(dir, '.git')))) throw new AppError('not_found', 'worktree_missing');
    await this.verifyFamily(repo, dir);
    const result = await git(dir, ['diff', '--no-ext-diff', from, to], { maxBytes: this.diffBytes });
    if (result.code !== 0) throw new AppError('not_found', 'checkpoint_missing');
    return { diff: result.stdout, truncated: result.truncated ?? false };
  }
  async merge(project: string, task: string, beforeMerge?: () => Promise<void>): Promise<MergeResult> {
    return this.mutate(project, async () => {
      await beforeMerge?.();
      return this.mergeLocked(project, task);
    });
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
      const merged = await git(repo, ['merge', '--no-ff', '--no-edit', '-m', `合併：${record.title}`, '-m', `${MERGE_TRAILER}${task}`, source]);
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
    const status = splitNull(await gitOk(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']));
    const leftover: string[] = [];
    for (let i = 0; i < status.length; i++) {
      const entry = status[i]!;
      leftover.push(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i++;
    }
    // Git refuses non-force removal even for clean initialized submodules; preserve and report them.
    for (const module of await gitlinkPaths(dir)) {
      if (await pathExists(path.join(dir, module, '.git')) && !leftover.includes(module)) leftover.push(module);
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
  /** 主資料夾最新的 commit 若正是這個作業的合併 commit，回其短 hash；否則 null（之後有人改過就不能自動撤銷）。 */
  async mergedInfo(project: string, task: string): Promise<{ commit: string } | null> {
    const repo = await this.bodyPath(project);
    if (!(await isRepo(repo))) return null;
    const message = await git(repo, ['log', '-1', '--format=%P%n%B']);
    if (message.code !== 0 || message.truncated) return null;
    const [parents = '', ...body] = message.stdout.split('\n');
    if (parents.trim().split(' ').length !== 2 || !body.some(line => line.trim() === `${MERGE_TRAILER}${task}`)) return null;
    return { commit: (await gitOk(repo, ['rev-parse', '--short', 'HEAD'])).trim() };
  }
  /** 撤銷剛完成的合併：主資料夾回到合併前，作業分支與副本重建，狀態回到進行中。 */
  async unmerge(project: string, task: string): Promise<Task> {
    return this.mutate(project, async () => {
      const repo = await this.bodyPath(project);
      const record = await this.tasks.get(project, task);
      if (!(await this.mergedInfo(project, task)) || (await gitOk(repo, ['status', '--porcelain'])).length > 0) throw new AppError('conflict', 'unmerge_unavailable');
      const before = (await gitOk(repo, ['rev-parse', 'HEAD^1'])).trim();
      // `reset --hard` silently overwrites ignored files sitting where it restores a file the merge had deleted.
      const restored = splitNull(await gitOk(repo, ['diff', '--name-only', '--no-renames', '-z', '--diff-filter=A', 'HEAD', before]));
      for (const file of restored) if (await occupied(repo, file)) throw new AppError('conflict', 'unmerge_unavailable');
      const source = (await gitOk(repo, ['rev-parse', 'HEAD^2'])).trim();
      const branch = this.branch(task);
      if (!(await branchExists(repo, branch))) await gitOk(repo, ['branch', branch, source]);
      await gitOk(repo, ['reset', '-q', '--hard', before]);
      const revived = await this.prepareLocked(project, task);
      await new CompletionStore(this.ws).revoke(project, task);
      await this.tasks.appendMemo(project, task, '已撤銷合併，工作副本已重建');
      await new OpLog(this.ws).record({ action: 'unmerge', project, task });
      return this.tasks.update(project, task, { state: '進行中', workdir: revived, ...(record.question ? { question: '' } : {}) });
    });
  }
  async exclusion(project: string, task: string, excluded: boolean): Promise<Task> {
    return this.mutate(project, () => this.tasks.update(project, task, { mergeExcluded: excluded }));
  }
  /** 封存前提交一般變更；原副本原子移入私有 recovery，git 不保存的資料也不刪除。 */
  async abandon(project: string, task: string): Promise<void> {
    await this.mutate(project, async () => {
      const { record, repo, dir } = await this.copy(project, task);
      // 直接在主資料夾工作的作業，workdir 就是主資料夾本身，絕不能移除。
      if (record.workspace !== 'direct') {
        const target = dir || this.ws.worktreeDir(project, task);
        if (path.resolve(target) !== this.ws.worktreeDir(project, task)) throw new AppError('conflict', 'archive_unsafe_path');
        if (await pathExists(target)) {
          if ((await fs.lstat(target)).isSymbolicLink() || (await fs.lstat(path.dirname(target))).isSymbolicLink() || !isInside(await fs.realpath(this.ws.workDir), await fs.realpath(target))) throw new AppError('conflict', 'archive_unsafe_path');
          const dead = await deadGitfile(target);
          let commit: { repo: string; sha: string } | undefined;
          if (!dead) {
            await this.verifyFamily(repo, target);
            const head = await git(target, ['symbolic-ref', '--short', '-q', 'HEAD']);
            if (head.stdout.trim() !== this.branch(task)) throw new AppError('conflict', 'worktree_wrong_branch');
            for (const module of await gitlinkPaths(target)) {
              if (await pathExists(path.join(target, module, '.git'))) throw new AppError('conflict', 'archive_cannot_preserve');
            }
            await commitAll(target, `${record.title}（封存前儲存）`);
            commit = { repo, sha: (await gitOk(target, ['rev-parse', 'HEAD'])).trim() };
          }
          // Rename retains ignored files, secrets and late writes without following symlinks.
          // If retention fails the source remains; never fall back to deleting the source.
          await new RecoveryStore(this.ws).preserve(project, task, target, commit);
          const removed = await git(repo, ['worktree', 'remove', '--force', target]);
          if (removed.code !== 0 && !dead) {
            await gitOk(repo, ['worktree', 'prune', '--expire', 'now']);
          }
        }
        await gitOk(repo, ['worktree', 'prune', '--expire', 'now']);
      }
      if (record.workdir) await this.tasks.update(project, task, { workdir: '' });
      await new OpLog(this.ws).record({ action: 'abandon', project, task });
    });
  }
  async revive(project: string, task: string): Promise<void> {
    await this.mutate(project, async () => {
      const record = await this.tasks.get(project, task);
      if (record.workspace === 'direct') return;
      const repo = await this.bodyPath(project), dir = this.ws.worktreeDir(project, task);
      if (await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; })) throw new AppError('conflict', 'archive_restore_conflict');
      const recovery = new RecoveryStore(this.ws);
      const snapshots = await recovery.snapshots(project, task);
      if (!snapshots.length && !(await isRepo(repo))) return;
      const retainedBranch = await branchExists(repo, this.branch(task));
      if (!retainedBranch && !snapshots.length) return;
      const originalHead = retainedBranch ? undefined : await recovery.retainedHead(project, task, repo);
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await gitOk(repo, ['worktree', 'prune', '--expire', 'now']);
      await gitOk(repo, retainedBranch
        ? ['worktree', 'add', '-q', dir, this.branch(task)]
        : ['worktree', 'add', '-q', '-b', this.branch(task), dir, originalHead!]);
      try {
        await recovery.restoreFreshCheckout(project, task, dir);
        await this.tasks.update(project, task, { workdir: dir });
        if (snapshots.length) await recovery.retireRestored(project, task);
      } catch (error) {
        // This newly created checkout contains no unique data: the original is still in recovery.
        await gitOk(repo, ['worktree', 'remove', '--force', dir]);
        throw error;
      }
    });
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
/** 副本的 .git 檔所指的 gitdir 已不存在（git 已移除登記）。 */
async function deadGitfile(dir: string): Promise<boolean> {
  const text = await fs.readFile(path.join(dir, '.git'), 'utf8').catch(() => null);
  const match = text === null ? null : /^gitdir:\s*(.+)$/m.exec(text);
  return match !== null && !(await pathExists(path.resolve(dir, match[1]!.trim())));
}
function splitNull(value: string): string[] { return value.split('\0').filter(Boolean); }
/** Gitlinks from the index, not .gitmodules (which can be stale or locally edited). */
async function gitlinkPaths(dir: string): Promise<string[]> {
  return splitNull(await gitOk(dir, ['ls-files', '--stage', '-z']))
    .filter(entry => entry.startsWith('160000 '))
    .map(entry => entry.slice(entry.indexOf('\t') + 1));
}
/** Something untracked already sits at `file` (a repository path), or a non-directory blocks one of its parent folders. */
async function occupied(repo: string, file: string): Promise<boolean> {
  const parts = file.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await fs.lstat(path.join(repo, ...parts.slice(0, i))).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return false;
    if (i === parts.length || !stat.isDirectory()) return true;
  }
  return false;
}
async function mergeHead(dir: string): Promise<string | null> {
  const result = await git(dir, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
  if (result.code < 0 || result.truncated) throw new AppError('internal', 'git_failed');
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Copy untracked local settings without logging contents or following either side's symlinks. */
export async function copyLocalSecrets(repo: string, dir: string): Promise<string[]> {
  const tracked = new Set(splitNull(await gitOk(repo, ['ls-files', '-z'])));
  const modules = new Set(await gitlinkPaths(dir));
  const root = await fs.realpath(dir);
  if ((await fs.lstat(dir)).isSymbolicLink()) throw new AppError('conflict', 'archive_unsafe_path');
  const copied: string[] = [];
  async function destinationParent(relative: string): Promise<string> {
    let current = dir;
    for (const part of path.dirname(relative).split(path.sep).filter(part => part !== '.')) {
      current = path.join(current, part);
      await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(root, await fs.realpath(current))) throw new AppError('conflict', 'archive_unsafe_path');
    }
    return current;
  }
  async function visit(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(repo, relative), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.ai' || entry.name === 'node_modules') continue;
      const file = path.join(relative, entry.name);
      const source = path.join(repo, file);
      const stat = await fs.lstat(source);
      if (stat.isDirectory()) {
        if (modules.has(file)) {
          // Leave uninitialized gitlinks empty so a later explicit submodule update can clone into them.
          if (!(await pathExists(path.join(dir, file, '.git')))) continue;
          for (const child of await gitlinkPaths(path.join(dir, file))) modules.add(path.join(file, child));
        }
        await visit(file);
      }
      else if (stat.isFile() && isLocalSecret(file) && !tracked.has(file)) {
        const parent = await destinationParent(file);
        const destination = path.join(parent, entry.name);
        const old = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (old) throw new AppError('conflict', old.isSymbolicLink() ? 'archive_unsafe_path' : 'archive_restore_conflict');
        const temporary = path.join(parent, `.ym-secret-${randomUUID()}`);
        const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!(await input.stat()).isFile()) throw new AppError('conflict', 'archive_unsafe_path');
          const output = await fs.open(temporary, 'wx', 0o600);
          try { await output.writeFile(await input.readFile()); } finally { await output.close(); }
          // Linking a completed regular file is atomic and refuses an existing destination,
          // including a symlink introduced after the check above.
          await fs.link(temporary, destination);
          copied.push(file);
        } finally {
          await input.close();
          await fs.rm(temporary, { force: true });
        }
      }
    }
  }
  await visit('');
  return copied;
}
