import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import { AppError } from '../shared/errors.ts';
import type { UploadResult } from '../shared/types.ts';
const ID = /^[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/u;
export const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
export function uploadPath(ws: Workspace, project: string, id: string): string {
  if (!ID.test(id)) throw new AppError('bad_request');
  return path.join(ws.uploadsDir(project), id);
}
export async function saveUpload(ws: Workspace, project: string, name: string, raw: Buffer): Promise<UploadResult> {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!IMAGE_TYPES[ext] || !raw.length) throw new AppError('bad_request');
  const id = `${randomUUID()}.${ext}`;
  await fs.mkdir(ws.uploadsDir(project), { recursive: true });
  await fs.writeFile(uploadPath(ws, project, id), raw, { flag: 'wx' });
  return { id, name: path.basename(name), url: `/api/upload?project=${encodeURIComponent(project)}&id=${id}` };
}
export async function attachImages(ws: Workspace, project: string, task: string, ids: string[], limit: number): Promise<string[]> {
  if (ids.length > limit || !ids.every(id => typeof id === 'string' && ID.test(id)) || new Set(ids).size !== ids.length) throw new AppError('bad_request');
  const dir = ws.attachmentsDir(project, task);
  const targets = ids.map(id => path.join(dir, id));
  // 先確認整組圖片存在，避免無效輸入造成部分搬移。
  for (let i = 0; i < ids.length; i++) {
    try { await fs.access(uploadPath(ws, project, ids[i]!)); }
    catch { try { await fs.access(targets[i]!); } catch { throw new AppError('not_found'); } }
  }
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < ids.length; i++) {
    try { await fs.rename(uploadPath(ws, project, ids[i]!), targets[i]!); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  return targets;
}
