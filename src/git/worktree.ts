// 作業工作副本（R7）：Work/{專案}/{作業ID} 為 git worktree，分支 ym/{作業ID}。
// 收編由人觸發：先在副本與本體各自提交，再 --no-ff 合併；衝突即中止，本體不變。

import { promises as fs } from 'node:fs';
import type { Workspace } from '../ledger/workspace.ts';
import { AppError } from '../shared/errors.ts';
import { pathExists } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import type { MergeResult, WorktreeStatus } from '../shared/types.ts';
import { branchExists, commitAll, currentBranch, ensureRepo, git, gitOk } from './git.ts';

export class WorktreeService {
  private readonly ws: Workspace;
  private readonly diffBytes: number;

  constructor(ws: Workspace, diffBytes: number) {
    this.ws = ws;
    this.diffBytes = diffBytes;
  }

  branch(task: string): string {
    return `ym/${task}`;
  }

  /** 副本存在就回路徑，否則建立（必要時先把專案 git init）。 */
  async ensure(project: string, task: string): Promise<string> {
    const repo = this.ws.projectDir(project);
    const dir = this.ws.worktreeDir(project, task);
    if (await pathExists(dir)) {
      if (!(await pathExists(`${dir}/.git`))) throw new AppError('conflict', '副本目錄已存在但不是 worktree');
      return dir;
    }
    await ensureRepo(repo);
    await fs.mkdir(this.ws.workDir, { recursive: true });
    const branch = this.branch(task);
    if (await branchExists(repo, branch)) await gitOk(repo, ['worktree', 'add', '-q', dir, branch]);
    else await gitOk(repo, ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD']);
    log.info('建立工作副本', { project, task, dir, branch });
    return dir;
  }

  async status(project: string, task: string): Promise<WorktreeStatus> {
    const repo = this.ws.projectDir(project);
    const dir = this.ws.worktreeDir(project, task);
    const branch = this.branch(task);
    if (!(await pathExists(`${dir}/.git`))) return { exists: false, path: dir, branch, dirty: [], ahead: 0 };
    const porcelain = await gitOk(dir, ['status', '--porcelain']);
    const dirty = porcelain
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.slice(3).trim());
    const main = await currentBranch(repo);
    const ahead = Number((await git(repo, ['rev-list', '--count', `${main}..${branch}`])).stdout.trim() || 0);
    return { exists: true, path: dir, branch, dirty, ahead };
  }

  /** 收編前預覽：相對合併基底的已提交＋未提交變更，加上未追蹤檔內容。 */
  async diff(project: string, task: string): Promise<{ diff: string; truncated: boolean }> {
    const repo = this.ws.projectDir(project);
    const dir = this.ws.worktreeDir(project, task);
    if (!(await pathExists(`${dir}/.git`))) throw new AppError('not_found', '尚未建立工作副本');
    const main = await currentBranch(repo);
    const base = (await gitOk(repo, ['merge-base', main, this.branch(task)])).trim();
    let out = (await git(dir, ['diff', base], { maxBytes: this.diffBytes })).stdout;
    const untracked = (await gitOk(dir, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter((f) => f !== '');
    for (const file of untracked.slice(0, 50)) {
      if (out.length > this.diffBytes) break;
      out += (await git(dir, ['diff', '--no-index', '--', '/dev/null', file], { maxBytes: this.diffBytes })).stdout;
    }
    const truncated = out.length > this.diffBytes;
    return { diff: truncated ? out.slice(0, this.diffBytes) : out, truncated };
  }

  /** 人工收編：副本提交 → 本體提交 → --no-ff 合併；衝突 abort 並回清單。 */
  async merge(project: string, task: string, title: string): Promise<MergeResult> {
    const repo = this.ws.projectDir(project);
    const dir = this.ws.worktreeDir(project, task);
    if (!(await pathExists(`${dir}/.git`))) throw new AppError('not_found', '尚未建立工作副本');
    const branch = this.branch(task);
    await commitAll(dir, `YuMeewADE: ${task} ${title}`.trim());
    await commitAll(repo, 'YuMeewADE: 收編前儲存');
    const r = await git(repo, ['merge', '--no-ff', '--no-edit', '-m', `收編 ${task}: ${title}`.trim(), branch]);
    if (r.code !== 0) {
      const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter((f) => f !== '');
      await git(repo, ['merge', '--abort']);
      log.warn('收編衝突，已中止', { project, task, conflicts });
      return { merged: false, conflicts };
    }
    const commit = (await gitOk(repo, ['rev-parse', '--short', 'HEAD'])).trim();
    log.info('收編完成', { project, task, commit });
    return { merged: true, commit };
  }

  /** 移除副本與分支；副本有未提交變更時拒絕（409）。分支若未合併則保留。 */
  async remove(project: string, task: string): Promise<void> {
    const repo = this.ws.projectDir(project);
    const dir = this.ws.worktreeDir(project, task);
    if (!(await pathExists(`${dir}/.git`))) throw new AppError('not_found', '尚未建立工作副本');
    const r = await git(repo, ['worktree', 'remove', dir]);
    if (r.code !== 0) throw new AppError('conflict', '副本有未提交的變更，請先收編或手動清理');
    const d = await git(repo, ['branch', '-d', this.branch(task)]);
    if (d.code !== 0) log.warn('分支未合併，保留', { project, task, branch: this.branch(task) });
  }
}
