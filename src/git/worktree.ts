// Work/{project}/{task} is a git worktree; only human-triggered merge publishes its changes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import { CompletionStore } from '../ledger/completion.ts';
import { OpLog } from '../ledger/oplog.ts';
import { AppError } from '../shared/errors.ts';
import { isInside, pathExists, withFileLocks } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import type { FileView, MergePreview, MergeResult, Task, TaskOverlap, TurnChanges } from '../shared/types.ts';
import { branchExists, commitAll, ensureRepo, git, gitOk, isLocalSecret, isRepo } from './git.ts';

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
      if (await isRepo(repo)) await commitAll(repo, 'YuMeewADE：開始前儲存');
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
    const { repo, dir } = await this.copy(project, task);
    return dir && await pathExists(path.join(dir, '.git')) ? dir : repo;
  }
  /** 可檢視的檔案（git 追蹤的＋未被忽略的新檔，不含本機機密檔）。 */
  async listFiles(project: string, task: string): Promise<string[]> {
    const root = await this.viewRoot(project, task);
    if (!(await isRepo(root))) return [];
    const tracked = splitNull(await gitOk(root, ['ls-files', '-z']));
    const fresh = splitNull(await gitOk(root, ['ls-files', '--others', '--exclude-standard', '-z']));
    return [...new Set([...tracked, ...fresh])].filter(file => !isLocalSecret(file)).sort();
  }
  /** 唯讀取檔：路徑必須在 listFiles 內、解析後仍在根目錄內（擋符號連結逃出）、只取前 FILE_VIEW_MAX 位元組。 */
  async readFile(project: string, task: string, relative: string): Promise<FileView> {
    if (!(await this.listFiles(project, task)).includes(relative)) throw new AppError('not_found', 'file_missing');
    const root = await fs.realpath(await this.viewRoot(project, task));
    const full = await fs.realpath(path.join(root, relative)).catch(() => null);
    if (!full || !isInside(root, full)) throw new AppError('not_found', 'file_missing');
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
    const stat = await gitOk(dir, ['diff', '--shortstat', base]);
    const untracked = splitNull(await gitOk(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(f => !isLocalSecret(f));
    const paths = splitNull(await gitOk(dir, ['diff', '--name-only', '-z', base]));
    const tree = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', mainHead, workHead]);
    if ((tree.code !== 0 && tree.code !== 1) || tree.truncated) throw new AppError('internal', 'git_failed');
    const branch = (await gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const target = (await gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const all = [...new Set([...paths, ...untracked])];
    return {
      branch,
      target,
      files: Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0) + untracked.length,
      added: Number(stat.match(/(\d+) insertions?/)?.[1] ?? 0),
      removed: Number(stat.match(/(\d+) deletions?/)?.[1] ?? 0),
      conflict: tree.code === 1,
      conflictPaths: tree.code === 1 ? splitNull(tree.stdout).slice(1) : [],
      paths: all,
      overlaps: await this.overlaps(project, task, repo, all),
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
          ...splitNull(await gitOk(other.workdir, ['diff', '--name-only', '-z', base])),
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
        ...splitNull(await gitOk(dir, ['diff', '--name-only', '-z', base])),
        ...splitNull(await gitOk(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(file => !isLocalSecret(file)),
      ]);
      if (!changed.has(relative)) throw new AppError('not_found', 'file_missing');
      const existed = (await git(dir, ['cat-file', '-e', `${base}:${relative}`])).code === 0;
      if (existed) {
        await gitOk(dir, ['checkout', base, '--', relative]);
        await gitOk(dir, ['reset', '-q', '--', relative]);
      } else if ((await git(dir, ['ls-files', '--error-unmatch', '--', relative])).code === 0) {
        await gitOk(dir, ['rm', '-f', '-q', '--', relative]);
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
  /** 每輪開始前把副本現況存成 commit 並回傳其 sha；直接在主資料夾工作（沒有副本）時回 undefined。 */
  async checkpoint(project: string, task: string): Promise<string | undefined> {
    return this.mutate(project, async () => {
      const { record, dir } = await this.copy(project, task);
      if (record.workspace === 'direct' || !dir || !(await pathExists(path.join(dir, '.git')))) return undefined;
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
      const reachable = await git(dir, ['merge-base', '--is-ancestor', sha, 'HEAD']);
      if (reachable.code !== 0) throw new AppError('not_found', 'checkpoint_missing');
      await gitOk(dir, ['reset', '-q', '--hard', sha]);
      await gitOk(dir, ['clean', '-fdq', '-e', '.env*', '-e', '.npmrc', '-e', '.dev.vars*']);
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
