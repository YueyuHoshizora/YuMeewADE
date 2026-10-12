import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../ledger/workspace.ts';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';

/** Recovery owns the original directory, not a best-effort copy of files that git excludes. */
export class RecoveryStore {
  private readonly ws: Workspace;
  constructor(ws: Workspace) { this.ws = ws; }
  private root(project: string, task: string): string {
    this.ws.worktreeDir(project, task);
    return path.join(this.ws.internalDir, 'recovery', project, task);
  }
  async snapshots(project: string, task: string): Promise<string[]> {
    const root = this.root(project, task);
    await this.safeDirectory(root, false);
    return (await fs.readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; }))
      .filter(name => /^[0-9]{13}-[a-f0-9-]{36}$/.test(name)).sort().reverse();
  }
  private async safeDirectory(dir: string, create: boolean): Promise<void> {
    const base = await fs.realpath(this.ws.root);
    const relative = path.relative(this.ws.root, dir);
    let current = this.ws.root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (create) await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (!create && error.code === 'ENOENT') return null; throw error; });
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(base, await fs.realpath(current))) throw new AppError('conflict', 'archive_unsafe_path');
      if (create) await fs.chmod(current, 0o700);
    }
  }
  async preserve(project: string, task: string, source: string): Promise<string> {
    const expected = this.ws.worktreeDir(project, task);
    if (path.resolve(source) !== expected || (await fs.lstat(source)).isSymbolicLink() || !isInside(await fs.realpath(this.ws.workDir), await fs.realpath(source))) throw new AppError('conflict', 'archive_unsafe_path');
    const root = this.root(project, task);
    await this.safeDirectory(root, true);
    const destination = path.join(root, `${Date.now()}-${randomUUID()}`);
    await fs.rename(source, destination);
    await fs.chmod(destination, 0o700);
    return destination;
  }
  /** Retain the bytes but retire this generation from automatic future restores. */
  async retireRestored(project: string, task: string): Promise<void> {
    const root = this.root(project, task);
    await this.safeDirectory(root, false);
    await fs.rename(root, `${root}.restored-${randomUUID()}`);
  }
  /** Only called for a checkout just created by revive, never an existing user's directory. */
  async restoreFreshCheckout(project: string, task: string, destination: string): Promise<void> {
    const snapshots = await this.snapshots(project, task);
    if (!snapshots.length) return;
    const source = path.join(this.root(project, task), snapshots[0]!);
    await this.safeDirectory(source, false);
    const root = await fs.realpath(destination);
    if ((await fs.lstat(destination)).isSymbolicLink()) throw new AppError('conflict', 'archive_unsafe_path');
    // The retained directory is authoritative, including absent tracked paths and late edits.
    // Keep the new registration rather than copying the now-dead snapshot .git file.
    for (const entry of await fs.readdir(destination)) {
      if (entry !== '.git') await fs.rm(path.join(destination, entry), { recursive: true, force: true });
    }
    const copy = async (relative: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
        if (entry.name === '.git' && !relative) continue;
        const rel = path.join(relative, entry.name);
        // Targets are built under the canonical root: on macOS `/var/…` is `/private/var/…`, and a link resolved from the
        // alias would look as if it pointed outside the copy.
        const from = path.join(source, rel), to = path.join(root, rel);
        if (entry.isDirectory()) {
          await fs.mkdir(to, { mode: 0o700 });
          if (!isInside(root, await fs.realpath(to))) throw new AppError('conflict', 'archive_unsafe_path');
          await copy(rel);
        } else if (entry.isFile()) {
          await fs.copyFile(from, to, constants.COPYFILE_EXCL);
          await fs.chmod(to, (await fs.stat(from)).mode & 0o777);
        } else if (entry.isSymbolicLink()) {
          const link = await fs.readlink(from);
          if (!isInside(root, path.resolve(path.dirname(to), link))) throw new AppError('conflict', 'archive_unsafe_path');
          if (await fs.lstat(to).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; })) throw new AppError('conflict', 'archive_restore_conflict');
          await fs.symlink(link, to);
        } else throw new AppError('conflict', 'archive_cannot_preserve');
      }
    };
    await copy('');
  }
}
