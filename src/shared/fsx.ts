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

// 同一檔案的 read-modify-write 必須排隊；多個服務實例仍共用這個鎖，避免核可或設定互相覆蓋。
const jsonUpdates = new Map<string, Promise<unknown>>();
export async function updateJson<T>(file: string, fallback: T, change: (value: T) => void): Promise<T> {
  const key = path.resolve(file);
  const job = (jsonUpdates.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const value = await readJson(file, fallback);
    change(value);
    await writeJson(file, value);
    return value;
  });
  jsonUpdates.set(key, job);
  try { return await job; }
  finally { if (jsonUpdates.get(key) === job) jsonUpdates.delete(key); }
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
