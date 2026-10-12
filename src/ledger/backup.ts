import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from './workspace.ts';
import { ProjectLedger } from './projects.ts';
import { TaskLedger } from './tasks.ts';
import { atomicWrite, isInside, missingAs, withFileLocks, writeJson } from '../shared/fsx.ts';
import { parseFrontmatter, patchHeaderLines, serializeFrontmatter, type Frontmatter } from '../shared/frontmatter.ts';
import { AppError } from '../shared/errors.ts';
import { git } from '../git/git.ts';
import type { CareBackup } from '../shared/types.ts';
import type { CareCapacity } from '../shared/backup-types.ts';
import { encryptSnapshot, receiveEncrypted, decryptSnapshot } from './portable-backup.ts';

interface Manifest { format: 1; id: string; createdAt: string; root: string; originalRoot: string; external: { project: string; source: string; originalSource: string; folder: string }[]; complete: boolean; fingerprint: string }
const excluded = (name: string) => /^(credentials\.sqlite(?:[-.].*)?|credentials\.key|master\.key|core\.lock|cli-accounts|auth\.json|\.credentials\.json|\.device-keys\.json|antigravity-oauth-token)$/i.test(name);
const fail = (detail: 'care_changed' | 'care_backup_invalid' | 'care_destination_exists' | 'care_external_required' | 'care_repository_unsupported' | 'care_backup_overlap') => new AppError('conflict', detail);
/** A backup id or destination parent that does not exist is invalid input, not an internal error. */
const invalidIfMissing = missingAs(() => fail('care_backup_invalid'));
const inside = (root: string, file: string) => root === file || isInside(root, file);

/** Private snapshots intentionally contain prompts and local .env files; never served as downloads. */
export class BackupService {
  private readonly ws: Workspace;
  private readonly directory: string;
  private readonly active = new Set<string>();
  constructor(ws: Workspace, directory: string) { this.ws = ws; this.directory = directory; }
  private async privateRoot(): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(this.directory);
    if ((await fs.lstat(this.directory)).isSymbolicLink() || inside(await fs.realpath(this.ws.root), root)) throw fail('care_backup_invalid');
    await fs.chmod(root, 0o700);
    return root;
  }
  async list(): Promise<CareBackup[]> {
    const directory = await this.privateRoot();
    const result: CareBackup[] = [];
    for (const id of await fs.readdir(directory)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      try {
        const manifest = await this.manifest(id);
        result.push({ id, createdAt: manifest.createdAt, complete: manifest.complete, externalCount: manifest.external.length, containsSecrets: true, bytes: await treeBytes(path.join(directory, id)) });
      } catch { continue; }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async capacity(): Promise<CareCapacity> {
    const directory = await this.privateRoot(); const disk = await fs.statfs(directory);
    const entries = await this.list();
    return { usedBytes: await treeBytes(directory), availableBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize, backups: entries.length };
  }
  async delete(id: string, confirmation: string): Promise<void> {
    if (confirmation !== id || this.active.has(id)) throw fail('care_backup_invalid');
    this.active.add(id);
    try { await this.manifest(id); }
    catch (error) { this.active.delete(id); throw error; }
    try { await fs.rm(path.join(await this.privateRoot(), id), { recursive: true }); }
    finally { this.active.delete(id); }
  }
  async retain(count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw fail('care_backup_invalid');
    const complete: CareBackup[] = [];
    const root = await fs.realpath(this.ws.root);
    for (const entry of await this.list()) {
      if (!entry.complete) continue;
      try {
        const manifest = await this.manifest(entry.id); if (manifest.root !== root) continue;
        const folder = path.join(await this.privateRoot(), entry.id);
        const unique = manifest.external.filter((e, i, all) => all.findIndex(x => x.source === e.source) === i);
        if (await fingerprint([path.join(folder, 'workspace'), ...unique.map(e => path.join(folder, 'external', e.folder))]) === manifest.fingerprint) complete.push(entry);
      } catch { continue; }
    }
    for (const entry of complete.slice(count)) {
      if (this.active.has(entry.id)) continue;
      this.active.add(entry.id);
      try {
        const manifest = await this.manifest(entry.id); const folder = path.join(await this.privateRoot(), entry.id);
        const unique = manifest.external.filter((e, i, all) => all.findIndex(x => x.source === e.source) === i);
        let intact = false;
        try { intact = await fingerprint([path.join(folder, 'workspace'), ...unique.map(e => path.join(folder, 'external', e.folder))]) === manifest.fingerprint; } catch { continue; }
        if (intact) await fs.rm(folder, { recursive: true });
      } finally { this.active.delete(entry.id); }
    }
  }
  async export(id: string, password: string, consume: (file: string) => Promise<void>): Promise<void> {
    if (this.active.has(id)) throw fail('care_backup_invalid');
    this.active.add(id);
    let temporary = '';
    try {
      const manifest = await this.manifest(id); if (!manifest.complete) throw fail('care_external_required');
      const directory = await this.privateRoot(); temporary = await fs.mkdtemp(path.join(directory, '.export-'));
      const file = path.join(temporary, 'portable.ymae'); await encryptSnapshot(path.join(directory, id), file, password); await consume(file);
    } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); this.active.delete(id); }
  }
  async import(input: AsyncIterable<Uint8Array>, password: string, destination: string): Promise<{ root: string }> {
    const directory = await this.privateRoot(); const temporary = await fs.mkdtemp(path.join(directory, '.import-'));
    let imported = '';
    try {
      const encrypted = path.join(temporary, 'encrypted'); const plain = path.join(temporary, 'plain'); const unpacked = path.join(temporary, 'unpacked');
      await receiveEncrypted(input, encrypted); await decryptSnapshot(encrypted, plain, unpacked, password);
      const manifestPath = path.join(unpacked, 'manifest.json');
      const stat = await fs.lstat(manifestPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw fail('care_backup_invalid');
      const value: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!value || typeof value !== 'object') throw fail('care_backup_invalid');
      const manifest = value as Manifest; manifest.id = randomUUID();
      await fs.unlink(manifestPath); await writeJson(manifestPath, manifest); await fs.chmod(manifestPath, 0o600);
      imported = manifest.id; await fs.rename(unpacked, path.join(directory, imported));
      return await this.restore(imported, destination);
    } finally { if (imported) await fs.rm(path.join(directory, imported), { recursive: true, force: true }); await fs.rm(temporary, { recursive: true, force: true }); }
  }
  private async manifest(id: string): Promise<Manifest> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw fail('care_backup_invalid');
    const directory = await this.privateRoot();
    const folder = path.join(directory, id);
    if ((await fs.lstat(folder).catch(invalidIfMissing)).isSymbolicLink()) throw fail('care_backup_invalid');
    const manifestFile = path.join(folder, 'manifest.json'); const stat = await fs.lstat(manifestFile).catch(invalidIfMissing);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw fail('care_backup_invalid');
    let value: Manifest;
    try { value = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as Manifest; } catch (error) { if (error instanceof SyntaxError) throw fail('care_backup_invalid'); throw error; }
    if (!value || value.format !== 1 || value.id !== id || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint) || typeof value.root !== 'string' || !path.isAbsolute(value.root) || typeof value.originalRoot !== 'string' || !path.isAbsolute(value.originalRoot) || typeof value.complete !== 'boolean' || !Array.isArray(value.external) || value.external.length > 10000 || value.external.some(e => !e || typeof e.project !== 'string' || typeof e.folder !== 'string' || !/^[0-9]+$/.test(e.folder) || typeof e.source !== 'string' || !path.isAbsolute(e.source) || typeof e.originalSource !== 'string' || !path.isAbsolute(e.originalSource))) throw fail('care_backup_invalid');
    return value;
  }
  async create(includeExternal: boolean): Promise<CareBackup> {
    const directory = await this.privateRoot();
    const root = await fs.realpath(this.ws.root);
    const ledger = new ProjectLedger(this.ws);
    const external: Manifest['external'] = [];
    const repositories = new Set<string>();
    for (const project of await ledger.list()) {
      const body = await fs.realpath(ledger.bodyPath(project));
      repositories.add(body);
      if (!inside(root, body)) {
        const existing = external.find(e => e.source === body);
        external.push({ project: project.id, source: body, originalSource: path.resolve(ledger.bodyPath(project)), folder: existing?.folder ?? String(external.length) });
      }
    }
    // Archived projects keep their external code in place; restoring them later needs that code just as much.
    for (const file of await archivedProjectFiles(this.ws)) {
      const original = archivedBody((await fs.readFile(file, 'utf8')));
      const body = original ? await fs.realpath(original).catch(() => null) : null;
      if (!body || inside(root, body)) continue;
      repositories.add(body);
      const existing = external.find(e => e.source === body);
      external.push({ project: path.basename(path.dirname(file)), source: body, originalSource: path.resolve(original!), folder: existing?.folder ?? String(external.length) });
    }
    // A complete backup copying an external folder that holds the backup storage would copy its own output forever.
    if (includeExternal && external.some(e => inside(e.source, directory))) throw fail('care_backup_overlap');
    return withFileLocks([...repositories], async () => {
      const id = randomUUID(); const pending = path.join(directory, `.${id}`); const folder = path.join(directory, id);
      await fs.mkdir(pending, { mode: 0o700 });
      const roots = [root, ...(includeExternal ? [...new Set(external.map(e => e.source))] : [])];
      try {
        for (const repo of repositories) {
          const dotgit = await fs.lstat(path.join(repo, '.git')).catch(() => null);
          // A linked external checkout depends on another repository; refuse an incomplete family.
          if (dotgit && !dotgit.isDirectory()) throw fail('care_repository_unsupported');
          if ((await fs.readFile(path.join(repo, '.git', 'objects', 'info', 'alternates'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; })).trim()) throw fail('care_repository_unsupported');
        }
        const before = await fingerprint(roots);
        const mappings = [{ source: root, target: path.join(pending, 'workspace') }, ...external.filter((e, i, all) => includeExternal && all.findIndex(x => x.source === e.source) === i).map(e => ({ source: e.source, target: path.join(pending, 'external', e.folder) }))];
        for (const mapping of mappings) await copyTree(mapping.source, mapping.target, mappings);
        if (before !== await fingerprint(roots)) throw fail('care_changed');
        const manifest: Manifest = { format: 1, id, createdAt: new Date().toISOString(), root, originalRoot: this.ws.root, external, complete: includeExternal || external.length === 0, fingerprint: await fingerprint(mappings.map(e => e.target)) };
        await writeJson(path.join(pending, 'manifest.json'), manifest);
        await fs.chmod(path.join(pending, 'manifest.json'), 0o600);
        await fs.rename(pending, folder);
        return { id, createdAt: manifest.createdAt, complete: manifest.complete, externalCount: external.length, containsSecrets: true, bytes: await treeBytes(folder) };
      } catch (error) { await fs.rm(pending, { recursive: true, force: true }); throw error; }
    });
  }
  async restore(id: string, destination: string): Promise<{ root: string }> {
    if (this.active.has(id)) throw fail('care_backup_invalid');
    this.active.add(id);
    try { return await this.restoreSnapshot(id, destination); } finally { this.active.delete(id); }
  }
  private async restoreSnapshot(id: string, destination: string): Promise<{ root: string }> {
    const manifest = await this.manifest(id);
    if (!manifest.complete) throw fail('care_external_required');
    if (!path.isAbsolute(destination) || /[\0\r\n]/.test(destination)) throw fail('care_backup_invalid');
    const parent = await fs.realpath(path.dirname(destination)).catch(invalidIfMissing);
    const root = path.join(parent, path.basename(destination));
    if (inside(await fs.realpath(this.ws.root), root) || inside(await this.privateRoot(), root)) throw fail('care_backup_invalid');
    try { await fs.mkdir(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw fail('care_destination_exists'); throw error; }
    const folder = path.join(await this.privateRoot(), id);
    const unique = manifest.external.filter((e, i, all) => all.findIndex(x => x.source === e.source) === i);
    const snapshots = [path.join(folder, 'workspace'), ...unique.map(e => path.join(folder, 'external', e.folder))];
    try {
      if (await fingerprint(snapshots) !== manifest.fingerprint) throw fail('care_backup_invalid');
      // External snapshots must never merge with workspace-owned files or symlinks.
      let externalName = 'External';
      if (unique.length) {
        for (let suffix = 0; ; suffix++) {
          externalName = suffix ? `External-${suffix}` : 'External';
          const occupied = await fs.lstat(path.join(folder, 'workspace', externalName)).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          });
          if (!occupied) break;
        }
      }
      const externalRoot = path.join(root, externalName);
      const mappings = [{ source: path.join(folder, 'workspace'), target: root }, ...unique.map(e => ({ source: path.join(folder, 'external', e.folder), target: path.join(externalRoot, e.folder) }))];
      for (const mapping of mappings) await copyTree(mapping.source, mapping.target, mappings);
      const restored = new Workspace(root); const projects = new ProjectLedger(restored); const tasks = new TaskLedger(restored);
      const translate = (old: string): string => {
        const external = manifest.external.find(e => inside(e.source, old) || inside(e.originalSource, old));
        if (external) return path.join(externalRoot, external.folder, path.relative(inside(external.source, old) ? external.source : external.originalSource, old));
        if (inside(manifest.root, old)) return path.join(root, path.relative(manifest.root, old));
        if (inside(manifest.originalRoot, old)) return path.join(root, path.relative(manifest.originalRoot, old));
        throw fail('care_backup_invalid');
      };
      for (const project of await projects.list()) {
        if (project.body) await projects.update(project.id, { body: translate(project.body) });
        const repo = (await projects.get(project.id)).body || restored.projectDir(project.id);
        if ((await fs.lstat(path.join(repo, '.git')).catch(() => null))?.isDirectory()) {
          await relocateWorktreeConfig(repo, path.join(repo, '.git', 'config'), repo);
          await relocateWorktreeConfig(repo, path.join(repo, '.git', 'config.worktree'), repo);
        }
        const copies: string[] = [];
        for (const task of await tasks.list(project.id)) {
          if (!task.workdir) continue;
          const workdir = translate(task.workdir);
          await tasks.update(project.id, task.id, { workdir });
          const marker = path.join(workdir, '.git');
          const stat = await fs.lstat(marker).catch(() => null);
          if (stat?.isFile()) {
            const text = await fs.readFile(marker, 'utf8');
            const oldGit = /^gitdir: (.+)\s*$/u.exec(text)?.[1];
            if (!oldGit) throw fail('care_backup_invalid');
            const gitdir = translate(path.resolve(task.workdir, oldGit));
            if (!inside(path.join(repo, '.git', 'worktrees'), gitdir)) throw fail('care_backup_invalid');
            await fs.writeFile(marker, `gitdir: ${gitdir}\n`, { mode: 0o600 });
            await fs.writeFile(path.join(gitdir, 'gitdir'), `${marker}\n`, { mode: 0o600 });
            copies.push(workdir);
          }
        }
        const registrations = path.join(repo, '.git', 'worktrees');
        for (const name of await fs.readdir(registrations).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]; throw error; })) {
          const gitdir = path.join(registrations, name);
          const pointer = (await fs.readFile(path.join(gitdir, 'gitdir'), 'utf8')).trim();
          let marker: string;
          try { marker = inside(root, pointer) ? pointer : translate(pointer); }
          catch { await fs.rm(gitdir, { recursive: true, force: true }); continue; }
          if (!(await fs.lstat(marker).catch(() => null))?.isFile()) { await fs.rm(gitdir, { recursive: true, force: true }); continue; }
          await fs.writeFile(marker, `gitdir: ${gitdir}\n`, { mode: 0o600 });
          await fs.writeFile(path.join(gitdir, 'gitdir'), `${marker}\n`, { mode: 0o600 });
          await relocateWorktreeConfig(path.dirname(marker), path.join(gitdir, 'config.worktree'), path.dirname(marker));
          if (!copies.includes(path.dirname(marker))) copies.push(path.dirname(marker));
        }
        if (copies.length) {
          const repair = await git(repo, ['worktree', 'repair', ...copies]);
          if (repair.code !== 0) throw fail('care_backup_invalid');
          const common = await fs.realpath(path.join(repo, '.git'));
          for (const copy of copies) {
            const check = await git(copy, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
            if (check.code !== 0 || await fs.realpath(check.stdout.trim()) !== common) throw fail('care_backup_invalid');
            await validateWorktreeRoot(copy);
          }
        }
        if ((await fs.lstat(path.join(repo, '.git')).catch(() => null))?.isDirectory()) await validateWorktreeRoot(repo);
      }
      for (const file of await archivedProjectFiles(restored)) {
        let parsed: Frontmatter; let moved: string;
        // Code that no longer existed at backup time was not captured; its archive keeps the original path.
        try { parsed = parseFrontmatter(await fs.readFile(file, 'utf8')); const body = archivedBody(parsed); if (!body) continue; moved = translate(body); } catch { continue; }
        await atomicWrite(file, serializeFrontmatter(patchHeaderLines(parsed.headerLines, { body: moved }), parsed.body));
        if ((await fs.lstat(path.join(moved, '.git')).catch(() => null))?.isDirectory()) {
          await relocateWorktreeConfig(moved, path.join(moved, '.git', 'config'), moved);
          await relocateWorktreeConfig(moved, path.join(moved, '.git', 'config.worktree'), moved);
        }
      }
      return { root };
    } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
  }
}

/** PROJECT.md of each archived project (`Projects/.trash/{name}-{stamp}/`). */
async function archivedProjectFiles(ws: Workspace): Promise<string[]> {
  const trash = path.join(ws.projectsDir, '.trash');
  const entries = await fs.readdir(trash, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(trash, entry.name, 'PROJECT.md');
    if ((await fs.lstat(file).catch(() => null))?.isFile()) files.push(file);
  }
  return files;
}
function archivedBody(source: string | Frontmatter): string | undefined {
  let body: unknown;
  try { body = (typeof source === 'string' ? parseFrontmatter(source) : source).data['body']; } catch { return undefined; }
  return typeof body === 'string' && path.isAbsolute(body) ? body : undefined;
}

async function relocateWorktreeConfig(cwd: string, config: string, root: string): Promise<void> {
  // --local omits config.worktree; --worktree can alias the shared config when the extension is disabled.
  const configured = await git(cwd, ['config', '--file', config, '--get', 'core.worktree']);
  if (configured.code === 0) {
    const updated = await git(cwd, ['config', '--file', config, 'core.worktree', root]);
    if (updated.code !== 0) throw fail('care_backup_invalid');
    await fs.chmod(config, 0o600);
  } else if (configured.code !== 1) throw fail('care_backup_invalid');
}

async function validateWorktreeRoot(root: string): Promise<void> {
  const check = await git(root, ['rev-parse', '--show-toplevel']);
  if (check.code !== 0 || await fs.realpath(check.stdout.trim()) !== await fs.realpath(root)) throw fail('care_backup_invalid');
}

async function copyTree(source: string, target: string, mappings: { source: string; target: string }[]): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    const real = await fs.realpath(source); const mapping = mappings.find(e => inside(e.source, real));
    if (!mapping) throw fail('care_backup_invalid');
    // A link to an excluded credential file (or into an excluded folder) is left out with its target; copied, it would
    // dangle and make the whole snapshot unrestorable.
    if (path.relative(mapping.source, real).split(path.sep).some(excluded)) return;
    await fs.symlink(path.relative(path.dirname(target), path.join(mapping.target, path.relative(mapping.source, real))), target);
  } else if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of (await fs.readdir(source)).sort()) if (!excluded(name)) await copyTree(path.join(source, name), path.join(target, name), mappings);
  } else if (stat.isFile()) {
    await fs.copyFile(source, target); await fs.chmod(target, stat.mode & 0o100 ? 0o700 : 0o600);
  } else throw fail('care_backup_invalid');
}
async function fingerprint(roots: string[]): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (file: string, relative: string): Promise<void> => {
    const stat = await fs.lstat(file); hash.update(JSON.stringify([relative, stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f', stat.mode & 0o100]));
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) { if (!excluded(name)) await walk(path.join(file, name), `${relative}/${name}`); }
    else if (stat.isSymbolicLink()) hash.update(await fs.readlink(file));
    else if (stat.isFile()) { const handle = await fs.open(file, 'r'); try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); } }
    else throw fail('care_backup_invalid');
  };
  for (let index = 0; index < roots.length; index++) await walk(roots[index]!, String(index));
  return hash.digest('hex');
}

async function treeBytes(file: string): Promise<number> {
  const stat = await fs.lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let bytes = 0;
  const names = await fs.readdir(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]; throw error; });
  for (const name of names) bytes += await treeBytes(path.join(file, name));
  return bytes;
}
