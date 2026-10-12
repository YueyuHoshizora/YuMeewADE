import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitOk, isLocalSecret } from '../git/git.ts';
import { withFileLocks } from '../shared/fsx.ts';
import { AppError } from '../shared/errors.ts';
import { validateEncoding } from './editor-encoding.ts';
import type { EditorHistoryEntry } from '../shared/editor-workbench.ts';
export type HistoryEntry = EditorHistoryEntry;
const LIMIT = 16 * 1024 * 1024;
async function location(root: string): Promise<string> {
  const directory = (await gitOk(root, ['rev-parse', '--absolute-git-dir'])).trim();
  if (!path.isAbsolute(directory)) throw new AppError('bad_request');
  const real = await fs.realpath(directory);
  if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) throw new AppError('bad_request');
  return path.join(real, 'yumeewade-local-history.json');
}
async function load(file: string): Promise<HistoryEntry[]> {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > LIMIT) throw new AppError('too_large');
    const entries: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!Array.isArray(entries) || entries.length > 200 || entries.some(item => !item || typeof item.id !== 'string' || typeof item.path !== 'string' || typeof item.text !== 'string' || typeof item.revision !== 'string' || !Number.isSafeInteger(item.timestamp))) throw new AppError('bad_request');
    for (const item of entries) {
      if (item.encoding !== undefined) validateEncoding(item.encoding);
      if (item.range !== undefined && (!item.range || !Number.isSafeInteger(item.range.offset) || !Number.isSafeInteger(item.range.end) || item.range.offset < 0 || item.range.end < item.range.offset || item.range.end - item.range.offset > 262144)) throw new AppError('bad_request');
      if (item.reason === 'segment' && !item.range) throw new AppError('bad_request');
    }
    return entries as HistoryEntry[];
  } finally { await handle.close(); }
}
export async function historyEntries(root: string, relative: string): Promise<HistoryEntry[]> { return (await load(await location(root))).filter(item => item.path === relative).reverse(); }
export async function preserveHistory(root: string, entry: Omit<HistoryEntry, 'id' | 'timestamp'>): Promise<void> {
  if (isLocalSecret(entry.path) || entry.path.split('/').some(isLocalSecret) || Buffer.byteLength(entry.text) > 2 * 1024 * 1024) return;
  const file = await location(root);
  await withFileLocks([file], async () => {
    const entries = await load(file); if (entries.at(-1)?.path === entry.path && entries.at(-1)?.revision === entry.revision) return;
    entries.push({ ...entry, id: randomUUID(), timestamp: Date.now() });
    while (entries.filter(item => item.path === entry.path).length > 30) entries.splice(entries.findIndex(item => item.path === entry.path), 1);
    while (entries.length > 200 || Buffer.byteLength(JSON.stringify(entries)) > LIMIT) entries.shift();
    const tmp = `${file}.${randomUUID()}.tmp`; const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(entries)); await handle.sync(); await handle.close(); await fs.rename(tmp, file); }
    finally { await handle.close().catch(() => undefined); await fs.rm(tmp, { force: true }); }
  });
}
