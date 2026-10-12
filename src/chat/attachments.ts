import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import { AppError } from '../shared/errors.ts';
import type { UploadResult } from '../shared/types.ts';
import { isValidProjectName, isValidTaskId } from '../shared/names.ts';
import type { ChatStore } from './store.ts';
import { draftFile, readDrafts, type Drafts } from './drafts.ts';
import { pathExists, withFileLocks, writeJson } from '../shared/fsx.ts';
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/u;
export const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87 = Buffer.from('GIF87a');
const GIF89 = Buffer.from('GIF89a');
const RIFF = Buffer.from('RIFF');
const WEBP = Buffer.from('WEBP');
export function uploadPath(ws: Workspace, project: string, id: string): string {
  if (!ID.test(id)) throw new AppError('bad_request');
  return path.join(ws.uploadsDir(project), id);
}
export async function saveUpload(ws: Workspace, project: string, name: string, raw: Buffer): Promise<UploadResult> {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!IMAGE_TYPES[ext] || !raw.length) throw new AppError('bad_request');
  const matches = ext === 'png' ? raw.subarray(0, PNG.length).equals(PNG)
    : ext === 'jpg' || ext === 'jpeg' ? raw.subarray(0, JPEG.length).equals(JPEG)
    : ext === 'gif' ? raw.subarray(0, 6).equals(GIF87) || raw.subarray(0, 6).equals(GIF89)
    : raw.length >= 12 && raw.subarray(0, 4).equals(RIFF) && raw.subarray(8, 12).equals(WEBP);
  if (!matches) throw new AppError('bad_request', undefined, { field: 'name' });
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
    // Drafts retain the staged inode until send succeeds; no image-byte copying.
    try { await fs.link(uploadPath(ws, project, ids[i]!), targets[i]!); }
    catch (err) { if (!['ENOENT', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err; }
  }
  return targets;
}

export async function cleanupUploads(ws: Workspace, store: ChatStore, now = Date.now()): Promise<void> {
  for (const project of await fs.readdir(ws.projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory() || !isValidProjectName(project.name)) continue;
    const dir = ws.uploadsDir(project.name);
    if (!(await fs.lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    }))?.isDirectory()) continue;
    await withFileLocks([draftFile(ws, project.name)], async () => {
    const referenced = new Set<string>();
    // Unknown references make every upload potentially live: leave this project alone until its drafts file is repaired.
    let drafts: Drafts;
    try { drafts = await readDrafts(draftFile(ws, project.name)); }
    catch (error) { if (error instanceof AppError && error.detail === 'file_corrupt') return; throw error; }
    // An archived task's draft can no longer be opened or cleared, so its staged images expire like any unsent upload
    // instead of being kept forever; the draft drops them below so a restored task does not offer missing images.
    const archived: string[] = [];
    for (const [scope, draft] of Object.entries(drafts)) {
      if (scope !== 'quickstart' && (!isValidTaskId(scope) || !await pathExists(ws.taskFile(project.name, scope)))) { archived.push(scope); continue; }
      for (const image of draft.images) referenced.add(image.id);
    }
    const chatDir = path.join(ws.projectDir(project.name), '.ai', 'chat');
    const queues = await fs.readdir(chatDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    for (const name of queues) {
      if (!name.endsWith('.queue.json')) continue;
      const task = name.slice(0, -'.queue.json'.length);
      if (!isValidTaskId(task)) continue;
      for (const item of await store.readQueue(project.name, task)) {
        for (const image of item.images ?? []) referenced.add(image);
      }
    }
    for (const file of await fs.readdir(dir, { withFileTypes: true })) {
      if (!file.isFile() || !ID.test(file.name) || referenced.has(file.name)) continue;
      const target = path.join(dir, file.name);
      try {
        const stat = await fs.lstat(target);
        if (stat.isFile() && stat.mtimeMs < now - UPLOAD_TTL_MS) await fs.unlink(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    let pruned = false;
    for (const scope of archived) {
      const draft = drafts[scope]!;
      const kept: typeof draft.images = [];
      for (const image of draft.images) if (referenced.has(image.id) || await pathExists(path.join(dir, image.id))) kept.push(image);
      if (kept.length !== draft.images.length) { draft.images = kept; pruned = true; }
    }
    if (pruned) await writeJson(draftFile(ws, project.name), drafts);
    });
  }
}
