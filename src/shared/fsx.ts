// 檔案系統小工具：原子寫入（寫暫存檔後 rename）、存在判斷、安全 JSON 讀取。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (err) {
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

/** 讀取 JSON 檔；檔案不存在回 fallback，內容壞掉則丟錯（不冒充資料）。 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
  return JSON.parse(text) as T;
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
