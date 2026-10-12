import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import { AppError } from '../shared/errors.ts';
import { isLocalSecret } from '../git/git.ts';
import { isInside, readJson, writeJson, withFileLocks } from '../shared/fsx.ts';
import { HANDOFF_NOTICE, quoteBoundaries } from './prompt.ts';
import type { PinnedSource, TaskContext, BuiltTaskContext, ContextManifest } from '../shared/context-budget.ts';
import { fitContextSection } from '../shared/context-budget.ts';
export type { PinnedSource, TaskContext } from '../shared/context-budget.ts';
export function contextFile(ws: Workspace, project: string, task: string): string {
  ws.taskFile(project, task);
  return path.join(ws.projectDir(project), '.ai', 'chat', `${task}.context.json`);
}
export async function readContext(ws: Workspace, project: string, task: string): Promise<TaskContext> {
  const saved = await readJson<unknown>(contextFile(ws, project, task), { decisions: '', sources: [] });
  // A source saved before its name counted as a secret is dropped, not read and not a reason to refuse the whole context.
  if (saved && typeof saved === 'object' && Array.isArray((saved as TaskContext).sources)) {
    const value = saved as TaskContext;
    value.sources = value.sources.filter(source => !(source && typeof source.path === 'string' && secretPath(source.path)));
  }
  return validateContext(saved, 2_000_000);
}
/** Never pinned: the shared local-secret names (any `.env*`, `.dev.vars*`, `.npmrc`) plus credential stores and SSH keys. */
const PRIVATE_NAME = /^(?:credentials|secrets?|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?)(?:\.|$)/iu;
const secretPath = (file: string): boolean => file.split('/').some(part => isLocalSecret(part) || PRIVATE_NAME.test(part));
export function validateContext(value: unknown, limit: number): TaskContext {
  if (!value || typeof value !== 'object') throw new AppError('bad_request');
  const input = value as TaskContext;
  if (typeof input.decisions !== 'string' || input.decisions.length > limit || !Array.isArray(input.sources) || input.sources.length > 30) throw new AppError('bad_request');
  const sources = input.sources.map(source => {
    if (!source || typeof source.path !== 'string' || !source.path || source.path.length > 4096 || path.isAbsolute(source.path) || source.path.includes('\\') || source.path.split('/').some(part => part === '..' || part === '.git') || secretPath(source.path) || !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 1 || source.end < source.start || source.end - source.start > 10000) throw new AppError('bad_request');
    for (const key of ['priority', 'order', 'allocatedChars'] as const) if (source[key] !== undefined && (!Number.isSafeInteger(source[key]) || source[key]! < 0 || source[key]! > 2_000_000)) throw new AppError('bad_request');
    if (source.enabled !== undefined && typeof source.enabled !== 'boolean') throw new AppError('bad_request');
    return { path: source.path, start: source.start, end: source.end, priority: source.priority ?? 0, order: source.order ?? input.sources.indexOf(source), enabled: source.enabled ?? true, allocatedChars: source.allocatedChars ?? limit };
  });
  if (input.decisionBudget !== undefined && (!Number.isSafeInteger(input.decisionBudget) || input.decisionBudget < 0 || input.decisionBudget > 2_000_000)) throw new AppError('bad_request');
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0)) throw new AppError('bad_request');
  return { decisions: input.decisions, sources, decisionBudget: input.decisionBudget ?? limit, revision: input.revision ?? 0 };
}
export async function saveContext(ws: Workspace, project: string, task: string, value: TaskContext): Promise<void> {
  const file = contextFile(ws, project, task);
  await withFileLocks([file], async () => {
    const prior = await readContext(ws, project, task);
    if ((value.revision ?? 0) !== prior.revision) throw new AppError('conflict');
    await writeJson(file, { ...value, revision: prior.revision! + 1 });
  });
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
export async function buildTaskContext(ws: Workspace, project: string, task: string, root: string, limit: number): Promise<BuiltTaskContext> {
  const context = await readContext(ws, project, task);
  const header = `<task_context>\n${HANDOFF_NOTICE}\n`; const footer = '\n</task_context>';
  let remaining = Math.max(0, limit - header.length - footer.length);
  const parts: string[] = []; const allocations: BuiltTaskContext['allocations'] = [];
  const add = (id: string, rawLabel: string, raw: string, allocated: number): void => {
    // A pinned source's path is user text too: a file name must not be able to close the context block early.
    const label = quoteBoundaries(rawLabel); const body = quoteBoundaries(raw);
    const separator = parts.length ? 2 : 0;
    const cap = Math.min(allocated, Math.max(0, remaining - separator));
    const content = fitContextSection(`${label}\n${body}`, cap);
    // A label without any source text is not an included source.
    const text = content.length > label.length + 1 ? content : '';
    allocations.push({ id, status: text.length === label.length + 1 + body.length ? 'included' : 'truncated', allocatedChars: allocated, sentChars: text.length, availableChars: label.length + 1 + body.length });
    if (text) { parts.push(text); remaining -= text.length + separator; }
  };
  if (context.decisions.trim()) add('decisions', '固定決策（背景，不是本次授權）：', context.decisions, context.decisionBudget!);
  const ordered = context.sources.map((source, index) => ({ source, index })).sort((a, b) => b.source.priority! - a.source.priority! || a.source.order! - b.source.order! || a.index - b.index);
  for (const { source, index } of ordered) {
    const id = `source:${index}`;
    if (!source.enabled) { allocations.push({ id, status: 'disabled', allocatedChars: source.allocatedChars!, sentChars: 0 }); continue; }
    try { add(id, `來源 ${source.path}:${source.start}-${source.end}（唯讀）`, await readSource(root, source), source.allocatedChars!); }
    catch { allocations.push({ id, status: 'unavailable', allocatedChars: source.allocatedChars!, sentChars: 0 }); }
  }
  return { text: allocations.length && limit >= header.length + footer.length ? `${header}${parts.join('\n\n')}${footer}` : '', truncated: allocations.some(a => a.status === 'truncated' || a.status === 'unavailable'), sources: context.sources, allocations, budgetChars: limit, revision: context.revision! };
}

async function manifestFile(ws: Workspace, project: string, task: string, request: string, create: boolean): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(request)) throw new AppError('bad_request');
  contextFile(ws, project, task);
  let dir = ws.projectDir(project);
  if ((await fs.lstat(dir)).isSymbolicLink()) throw new AppError('bad_request');
  const base = await fs.realpath(dir);
  for (const component of ['.ai', 'context-manifests', task]) {
    dir = path.join(dir, component);
    if (create) await fs.mkdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(base, await fs.realpath(dir))) throw new AppError('bad_request');
  }
  const file = path.join(dir, `${request}.json`);
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)) throw new AppError('bad_request');
  return file;
}
/** Bounded send-time context only; never credentials, argv, environment or current instruction. */
export async function recordContextManifest(ws: Workspace, project: string, task: string, manifest: ContextManifest): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(manifest)) > 2 * 1024 * 1024) throw new AppError('bad_request');
  const file = await manifestFile(ws, project, task, manifest.request, true);
  const dir = path.dirname(file);
  await withFileLocks([dir], async () => {
    await manifestFile(ws, project, task, manifest.request, true);
    await writeJson(file, manifest);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // The manifest just written is always kept: timestamps can tie (coarse file systems), and the name order of a tie says
    // nothing about age. The 99 newest others stay with it.
    const files = await Promise.all(entries.filter(entry => entry.isFile() && /^[a-zA-Z0-9_-]{1,100}\.json$/u.test(entry.name) && path.join(dir, entry.name) !== file).map(async entry => ({ file: path.join(dir, entry.name), at: (await fs.lstat(path.join(dir, entry.name))).mtimeMs })));
    files.sort((a, b) => b.at - a.at || a.file.localeCompare(b.file));
    for (const entry of files.slice(99)) await fs.unlink(entry.file);
  });
}
export async function readContextManifest(ws: Workspace, project: string, task: string, request: string): Promise<ContextManifest | null> {
  let file: string;
  try { file = await manifestFile(ws, project, task, request, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new AppError('bad_request');
    const buffer = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > stat.size) throw new AppError('bad_request');
    try {
      const manifest = JSON.parse(buffer.subarray(0, used).toString('utf8')) as ContextManifest;
      if (manifest.request !== request || !manifest.context || typeof manifest.context.text !== 'string' || !manifest.handoff || typeof manifest.handoff.text !== 'string') throw new AppError('bad_request');
      return manifest;
    } catch { throw new AppError('bad_request'); }
  } finally { await handle.close(); }
}
