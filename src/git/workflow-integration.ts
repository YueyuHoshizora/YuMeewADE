import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { WorktreeService } from './worktree.ts';
import { git, gitOk, commitAll, isLocalSecret } from './git.ts';
import { AppError } from '../shared/errors.ts';
import { isInside, withFileLocks } from '../shared/fsx.ts';

export interface IntegrationCandidate { task: string; base: string; head: string; sources: { task: string; head: string; fingerprint: string; snapshot: string }[]; conflicts: string[]; state: 'ready' | 'conflict'; diff: string; truncated: boolean }
/** Candidates are ordinary isolated task worktrees; main and upstream indexes never change. */
export class WorkflowIntegrationService {
  constructor(private readonly deps: { tasks: TaskLedger; worktrees: WorktreeService; busy: (project: string, task: string) => boolean }) {}
  private async fingerprint(dir: string): Promise<string> {
    const hash = createHash('sha256').update(await gitOk(dir, ['rev-parse', 'HEAD'])).update(await gitOk(dir, ['diff', '--binary', 'HEAD']));
    for (const name of (await gitOk(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).filter(name => !isLocalSecret(name)).sort()) {
      const file = path.join(dir, name); const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !isInside(await fs.realpath(dir), await fs.realpath(file))) throw new AppError('conflict', 'workflow_invalid');
      hash.update(name).update('\0').update(await fs.readFile(file));
    }
    return hash.digest('hex');
  }
  async create(project: string, parent: string, role: string, sources: string[]): Promise<IntegrationCandidate> {
    if (!sources.length || sources.length > 20 || new Set(sources).size !== sources.length) throw new AppError('bad_request', 'workflow_invalid');
    const repo = await this.deps.worktrees.bodyPath(project);
    return withFileLocks([path.join(repo, '.ai', 'workflow-integration')], async () => {
      const base = (await gitOk(repo, ['rev-parse', 'HEAD'])).trim();
      const candidateTask = await this.deps.tasks.create(project, { title: `${parent} · integration`, role, parent, kind: 'derived', derivedFrom: parent, workspace: 'isolated' });
      const dir = await this.deps.worktrees.prepareFrom(project, candidateTask.id, base);
      const records: IntegrationCandidate['sources'] = [];
      for (const source of sources) {
        if (this.deps.busy(project, source)) throw new AppError('conflict', 'workflow_busy');
        const task = await this.deps.tasks.get(project, source);
        if (task.workspace !== 'isolated' || !task.workdir) throw new AppError('conflict', 'workflow_invalid');
        if ((await gitOk(task.workdir, ['rev-parse', '--git-common-dir'])).trim() !== (await gitOk(dir, ['rev-parse', '--git-common-dir'])).trim()) throw new AppError('conflict', 'workflow_invalid');
        if ((await gitOk(task.workdir, ['ls-files', '-u'])).trim()) throw new AppError('conflict', 'merge_conflict');
        const fingerprint = await this.fingerprint(task.workdir); const head = (await gitOk(task.workdir, ['rev-parse', 'HEAD'])).trim();
        // stash create writes objects only, without modifying the source index or checkout.
        const stash = (await gitOk(task.workdir, ['stash', 'create'])).trim();
        const tree = (await gitOk(task.workdir, ['rev-parse', `${stash || head}^{tree}`])).trim();
        const snapshot = (await gitOk(task.workdir, ['commit-tree', tree, '-p', head, '-m', 'Workflow immutable upstream snapshot'])).trim();
        const scratch = await this.deps.tasks.create(project, { title: `${parent} · snapshot ${source}`, role, parent, kind: 'derived', derivedFrom: source, workspace: 'isolated' });
        const scratchDir = await this.deps.worktrees.prepareFrom(project, scratch.id, snapshot);
        for (const name of (await gitOk(task.workdir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).filter(name => !isLocalSecret(name))) {
          const target = path.join(scratchDir, name); await fs.mkdir(path.dirname(target), { recursive: true });
          if (!isInside(await fs.realpath(scratchDir), await fs.realpath(path.dirname(target)))) throw new AppError('conflict', 'workflow_invalid');
          await fs.copyFile(path.join(task.workdir, name), target, fs.constants.COPYFILE_EXCL);
        }
        await commitAll(scratchDir, 'Workflow immutable untracked snapshot');
        const finalSnapshot = (await gitOk(scratchDir, ['rev-parse', 'HEAD'])).trim();
        if (this.deps.busy(project, source) || fingerprint !== await this.fingerprint(task.workdir)) throw new AppError('conflict', 'workflow_invalid');
        records.push({ task: source, head, fingerprint, snapshot: finalSnapshot });
      }
      let conflicts: string[] = [];
      for (const source of records) {
        const result = await git(dir, ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-edit', source.snapshot]);
        if (result.code !== 0) {
          conflicts = (await gitOk(dir, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
          if (!conflicts.length) throw new AppError('internal', 'git_failed');
          break;
        }
      }
      const diff = await git(dir, ['diff', base], { maxBytes: 1_000_000 });
      if (diff.code !== 0) throw new AppError('internal', 'git_failed');
      if ((await gitOk(repo, ['rev-parse', 'HEAD'])).trim() !== base) throw new AppError('conflict');
      return { task: candidateTask.id, base, head: (await gitOk(dir, ['rev-parse', 'HEAD'])).trim(), sources: records, conflicts, state: conflicts.length ? 'conflict' : 'ready', diff: diff.stdout, truncated: diff.truncated ?? false };
    });
  }
  async resolve(project: string, candidate: IntegrationCandidate): Promise<IntegrationCandidate> {
    const task = await this.deps.tasks.get(project, candidate.task);
    if (!task.workdir || task.workspace !== 'isolated' || this.deps.busy(project, task.id)) throw new AppError('conflict', 'workflow_busy');
    if ((await gitOk(task.workdir, ['rev-parse', 'HEAD'])).trim() !== candidate.head) throw new AppError('conflict');
    const conflicts = (await gitOk(task.workdir, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
    if (conflicts.length) return { ...candidate, conflicts };
    await commitAll(task.workdir, 'Workflow human integration resolution');
    for (const source of candidate.sources) {
      if ((await git(task.workdir, ['merge-base', '--is-ancestor', source.snapshot, 'HEAD'])).code === 0) continue;
      const result = await git(task.workdir, ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-edit', source.snapshot]);
      if (result.code !== 0) {
        const next = (await gitOk(task.workdir, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
        if (!next.length) throw new AppError('internal', 'git_failed');
        return { ...candidate, head: (await gitOk(task.workdir, ['rev-parse', 'HEAD'])).trim(), conflicts: next };
      }
    }
    const diff = await git(task.workdir, ['diff', candidate.base], { maxBytes: 1_000_000 });
    return { ...candidate, head: (await gitOk(task.workdir, ['rev-parse', 'HEAD'])).trim(), conflicts: [], state: 'ready', diff: diff.stdout, truncated: diff.truncated ?? false };
  }
}
