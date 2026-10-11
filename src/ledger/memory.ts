import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { atomicWrite, isInside, withFileLocks } from '../shared/fsx.ts';
import { isValidProjectName } from '../shared/names.ts';
import type { MemoryFile } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';

export const MEMORY_MAX_BYTES = 256 * 1024;
export const MEMORY_MAX_FILES = 200;
export function validMemoryName(name: string): boolean {
  return name.length <= 120 && name.endsWith('.md') && isValidProjectName(name.slice(0, -3));
}
const revision = (text: string) => createHash('sha256').update(text).digest('hex');

export class MemoryLedger {
  private readonly ws: Workspace;
  constructor(ws: Workspace) { this.ws = ws; }
  private async directory(project: string): Promise<string> {
    const root = this.ws.projectDir(project);
    await fs.access(this.ws.projectFile(project)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new AppError('not_found', 'project_missing');
      throw error;
    });
    const dir = path.join(root, '.ai', 'memory');
    // AI-owned files may contain links: never follow them into another directory.
    for (const part of [root, path.join(root, '.ai'), dir]) {
      const stat = await fs.lstat(part).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new AppError('bad_request');
    }
    return dir;
  }
  private file(dir: string, name: string): string {
    if (!validMemoryName(name)) throw new AppError('bad_request', 'field_type', { field: 'name' });
    const file = path.join(dir, name);
    if (!isInside(dir, file)) throw new AppError('bad_request');
    return file;
  }
  async list(project: string): Promise<string[]> {
    const dir = await this.directory(project);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const names = entries.filter(entry => entry.isFile() && validMemoryName(entry.name)).map(entry => entry.name).sort();
    if (names.length > MEMORY_MAX_FILES) throw new AppError('conflict');
    return names;
  }
  private async readFile(file: string, name: string): Promise<MemoryFile> {
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found');
      throw new AppError('bad_request');
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MEMORY_MAX_BYTES) throw new AppError('bad_request', 'field_too_long', { field: 'text' });
      const bytes = Buffer.alloc(MEMORY_MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MEMORY_MAX_BYTES) throw new AppError('bad_request', 'field_too_long', { field: 'text' });
      const text = bytes.subarray(0, bytesRead).toString('utf8');
      return { name, text, revision: revision(text) };
    } finally { await handle.close(); }
  }
  async read(project: string, name: string): Promise<MemoryFile> {
    return this.readFile(this.file(await this.directory(project), name), name);
  }
  async save(project: string, name: string, text: string, expected: string | null): Promise<MemoryFile> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MEMORY_MAX_BYTES) throw new AppError('bad_request', 'field_too_long', { field: 'text' });
    const dir = await this.directory(project); const file = this.file(dir, name);
    return withFileLocks([dir], async () => {
      await this.check(file, name, expected);
      if (expected === null && (await this.list(project)).length >= MEMORY_MAX_FILES) throw new AppError('conflict');
      await atomicWrite(file, text);
      return { name, text, revision: revision(text) };
    });
  }
  async remove(project: string, name: string, expected: string): Promise<void> {
    const dir = await this.directory(project); const file = this.file(dir, name);
    await withFileLocks([dir], async () => { await this.check(file, name, expected); await fs.unlink(file); });
  }
  private async check(file: string, name: string, expected: string | null): Promise<void> {
    if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected))) throw new AppError('bad_request');
    let current: MemoryFile | null;
    try { current = await this.readFile(file, name); }
    catch (error) { if (error instanceof AppError && error.code === 'not_found') current = null; else throw error; }
    if ((current?.revision ?? null) !== expected) throw new AppError('conflict');
  }
}
