// 檔案系統小工具：原子寫入（寫暫存檔後 rename）、存在判斷、安全 JSON 讀取。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';

export async function atomicWrite(file: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    // A write cut short (disk full, I/O error) leaves a partial temp file that would otherwise pile up beside the ledger.
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** True for the errors a path that does not exist (or whose parent is not a folder) produces. */
export function isMissing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}
/**
 * For `.catch(missingAs(...))`: a path removed outside the app is an ordinary request outcome, so it becomes the given
 * client error instead of a 500; every other failure is rethrown unchanged.
 */
export function missingAs(replacement: () => Error): (error: unknown) => never {
  return error => { throw isMissing(error) ? replacement() : error; };
}

/** 讀取 JSON 檔；檔案不存在回 fallback，內容壞掉則丟錯（不冒充資料）。 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
  // JSON.parse rejects a leading byte order mark, which some Windows editors add when a user hand-edits the file.
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (cause) { throw corrupt(file, cause); }
  // An object/array fallback states the shape callers dereference; `null` or `[]` in place of `{}` would otherwise surface as TypeErrors.
  if (fallback !== null && typeof fallback === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(fallback))) throw corrupt(file);
  return value as T;
}
/** Only the file name is public: the user must know which file to repair, never its absolute path. */
function corrupt(file: string, cause?: unknown): AppError {
  return new AppError('internal', 'file_corrupt', { field: path.basename(file), ...(cause === undefined ? {} : { cause }) });
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

// 整段讀改寫共用程序級鎖；多檔依絕對路徑排序取得，失敗也釋放且不保留閒置項目。
const fileLocks = new Map<string, Promise<unknown>>();
export async function withFileLocks<T>(files: readonly string[], change: () => Promise<T>): Promise<T> {
  const keys = [...new Set(files.map(file => path.resolve(file)))].sort();
  const acquire = async (index: number): Promise<T> => {
    const key = keys[index];
    if (key === undefined) return change();
    const job = (fileLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => acquire(index + 1));
    fileLocks.set(key, job);
    try { return await job; }
    finally { if (fileLocks.get(key) === job) fileLocks.delete(key); }
  };
  return acquire(0);
}

export async function updateJson<T>(file: string, fallback: T, change: (value: T) => void): Promise<T> {
  return withFileLocks([file], async () => {
    const value = await readJson(file, fallback);
    change(value);
    await writeJson(file, value);
    return value;
  });
}

export async function appendLine(file: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, line + '\n', 'utf8');
}

/** 確認 target 位於 base 之內（防路徑逃逸）。 */
export function isInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Exclusive workspace writer ownership; a hard-link claim serializes stale-lock removal across processes. */
export async function acquireWorkspaceLock(root: string, port: number): Promise<() => Promise<void>> {
  const file = path.join(root, '.yumeewade', 'core.lock');
  return withFileLocks([file], async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const token = randomUUID();
    for (;;) {
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, port, token }) + '\n'); }
        catch (err) { await fs.rm(file, { force: true }); throw err; }
        finally { await handle.close(); }
        return async () => {
          await withFileLocks([file], async () => {
            const owner = await readJson<{ token?: string } | null>(file, null);
            if (owner?.token === token) await fs.rm(file, { force: true });
          });
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      let owner: { pid?: number; port?: number };
      try { owner = JSON.parse(await fs.readFile(file, 'utf8')) as typeof owner; }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('工作區核心鎖尚未寫完或已損壞，拒絕啟動', { cause });
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) throw new Error('工作區核心鎖無有效 PID，拒絕啟動');
      try {
        process.kill(owner.pid!, 0);
        throw new Error(`工作區已有核心程序（PID ${owner.pid}，port ${owner.port ?? '?'}），拒絕啟動`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
      const claim = `${file}.stale`;
      try { await fs.link(file, claim); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('另一程序正在接管工作區核心鎖，拒絕啟動', { cause: err });
      }
      try {
        const claimed = JSON.parse(await fs.readFile(claim, 'utf8')) as { pid?: number };
        if (claimed.pid !== owner.pid) continue;
        const stale = await fs.stat(claim);
        const current = await fs.stat(file).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null;
          throw err;
        });
        if (current?.ino === stale.ino && current.dev === stale.dev) await fs.unlink(file);
      } finally { await fs.unlink(claim); }
    }
  });
}
