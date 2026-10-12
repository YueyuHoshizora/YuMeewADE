import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import { AppError } from '../shared/errors.ts';
import { readJson, writeJson, withFileLocks } from '../shared/fsx.ts';
import { isValidTaskId } from '../shared/names.ts';
import type { UploadResult } from '../shared/types.ts';

export interface ReviewDraft { path: string; oldLine?: number; newLine?: number; hash: string; code: string; comment: string }
export interface Draft { images: UploadResult[]; reviews: ReviewDraft[] }
export type Drafts = Record<string, Draft>;
export const EMPTY_DRAFT = (): Draft => ({ images: [], reviews: [] });
export function draftFile(ws: Workspace, project: string): string { return path.join(ws.projectDir(project), '.ai', 'drafts.json'); }
export function draftScope(scope: string): string {
  if (scope !== 'quickstart' && !isValidTaskId(scope)) throw new AppError('bad_request');
  return scope;
}
/** Valid JSON of the wrong shape (a hand edit, a bad merge) names the file instead of failing later as an anonymous TypeError. */
export async function readDrafts(file: string): Promise<Drafts> {
  const drafts = await readJson<Drafts>(file, {});
  const list = (value: unknown, item: (entry: Record<string, unknown>) => boolean) => Array.isArray(value) && value.every(entry => !!entry && typeof entry === 'object' && !Array.isArray(entry) && item(entry as Record<string, unknown>));
  for (const draft of Object.values(drafts as Record<string, unknown>)) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !list((draft as Record<string, unknown>)['images'], image => typeof image['id'] === 'string') || !list((draft as Record<string, unknown>)['reviews'], () => true)) throw new AppError('internal', 'file_corrupt', { field: path.basename(file) });
  }
  return drafts;
}
export async function readDraft(ws: Workspace, project: string, scope: string): Promise<Draft> {
  return (await readDrafts(draftFile(ws, project)))[draftScope(scope)] ?? EMPTY_DRAFT();
}
export async function updateDraft(ws: Workspace, project: string, scope: string, change: (draft: Draft) => void): Promise<Draft> {
  const file = draftFile(ws, project); draftScope(scope);
  return withFileLocks([file], async () => {
    const drafts = await readDrafts(file);
    const draft = drafts[scope] ?? EMPTY_DRAFT(); change(draft);
    if (draft.images.length || draft.reviews.length) drafts[scope] = draft;
    else delete drafts[scope];
    await writeJson(file, drafts); return draft;
  });
}
export async function addDraftImage(ws: Workspace, project: string, scope: string, image: UploadResult, max: number): Promise<void> {
  await updateDraft(ws, project, scope, draft => {
    if (draft.images.length >= max) throw new AppError('bad_request');
    draft.images.push(image);
  });
}
export function validateReviews(value: unknown): ReviewDraft[] {
  if (!Array.isArray(value) || value.length > 500) throw new AppError('bad_request');
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new AppError('bad_request');
    const row = item as ReviewDraft;
    if (typeof row.path !== 'string' || row.path.length > 4096 || row.path.startsWith('/') || row.path.split(/[\\/]/u).some(p => p === '..') || !/^[a-f0-9]{64}$/u.test(row.hash) || typeof row.code !== 'string' || row.code.length > 10000 || typeof row.comment !== 'string' || row.comment.length > 10000 || (row.oldLine === undefined && row.newLine === undefined) || [row.oldLine, row.newLine].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 1))) throw new AppError('bad_request');
    return { path: row.path, hash: row.hash, code: row.code, comment: row.comment, ...(row.oldLine === undefined ? {} : { oldLine: row.oldLine }), ...(row.newLine === undefined ? {} : { newLine: row.newLine }) };
  });
}
export async function draftImagePath(ws: Workspace, project: string, scope: string, id: string): Promise<string> {
  const draft = await readDraft(ws, project, scope);
  if (!draft.images.some(image => image.id === id)) throw new AppError('not_found');
  const upload = path.join(ws.uploadsDir(project), id);
  if (await fs.stat(upload).catch(() => null)) return upload;
  if (scope !== 'quickstart') return path.join(ws.attachmentsDir(project, scope), id);
  throw new AppError('not_found');
}
