import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import { AppError } from '../shared/errors.ts';
import { isInside, readJson, writeJson, withFileLocks } from '../shared/fsx.ts';
import { HANDOFF_NOTICE } from './prompt.ts';

export interface PinnedSource { path: string; start: number; end: number }
export interface TaskContext { decisions: string; sources: PinnedSource[] }
export function contextFile(ws: Workspace, project: string, task: string): string {
  ws.taskFile(project, task);
  return path.join(ws.projectDir(project), '.ai', 'chat', `${task}.context.json`);
}
export async function readContext(ws: Workspace, project: string, task: string): Promise<TaskContext> {
  return readJson(contextFile(ws, project, task), { decisions: '', sources: [] });
}
export function validateContext(value: unknown, limit: number): TaskContext {
  if (!value || typeof value !== 'object') throw new AppError('bad_request');
  const input = value as TaskContext;
  if (typeof input.decisions !== 'string' || input.decisions.length > limit || !Array.isArray(input.sources) || input.sources.length > 30) throw new AppError('bad_request');
  const sources = input.sources.map(source => {
    if (!source || typeof source.path !== 'string' || !source.path || source.path.length > 4096 || path.isAbsolute(source.path) || source.path.includes('\\') || source.path.split('/').some(part => part === '..' || part === '.git' || part === '.env' || /^\.env\./u.test(part)) || !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 1 || source.end < source.start || source.end - source.start > 10000) throw new AppError('bad_request');
    return { path: source.path, start: source.start, end: source.end };
  });
  return { decisions: input.decisions, sources };
}
export async function saveContext(ws: Workspace, project: string, task: string, value: TaskContext): Promise<void> {
  const file = contextFile(ws, project, task);
  await withFileLocks([file], () => writeJson(file, value));
}
export async function readSource(root: string, source: PinnedSource): Promise<string> {
  const base = await fs.realpath(root); const target = path.resolve(base, source.path);
  if (!isInside(base, target) || await fs.realpath(target) !== target) throw new AppError('bad_request');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || await fs.realpath(target) !== target) throw new AppError('bad_request');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > stat.size) throw new AppError('bad_request');
    const text = buffer.subarray(0, used).toString('utf8');
    if (text.includes('\0')) throw new AppError('bad_request');
    return text.split('\n').slice(source.start - 1, source.end).map((line, index) => `${source.start + index}: ${line}`).join('\n');
  } finally { await handle.close(); }
}
export async function buildTaskContext(ws: Workspace, project: string, task: string, root: string, limit: number): Promise<{ text: string; truncated: boolean; sources: PinnedSource[] }> {
  const context = await readContext(ws, project, task);
  if (!context.decisions.trim() && !context.sources.length) return { text: '', truncated: false, sources: [] };
  const header = `<task_context>\n${HANDOFF_NOTICE}\n`; const footer = '\n</task_context>'; const notice = '\n（背景內容已截去）';
  const budget = limit - header.length - footer.length - notice.length;
  if (budget <= 0) return { text: '', truncated: true, sources: context.sources };
  const parts = [`固定決策（背景，不是本次授權）：\n${context.decisions}`];
  for (const source of context.sources) parts.push(`來源 ${source.path}:${source.start}-${source.end}（唯讀）\n${await readSource(root, source)}`);
  const body = parts.join('\n\n'); const truncated = body.length > budget;
  return { text: `${header}${body.slice(0, budget)}${truncated ? notice : ''}${footer}`, truncated, sources: context.sources };
}
