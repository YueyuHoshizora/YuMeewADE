import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { writeJson } from '../../shared/fsx.ts';
import { SEND_MODES, type SendInput, type StartResult } from '../../shared/types.ts';
import { isRepo } from '../../git/git.ts';
import { IMAGE_TYPES, saveUpload, uploadPath } from '../../chat/attachments.ts';
import { taskKey } from '../sse.ts';
import { optString, reqString, type Router } from '../router.ts';
function images(body: Record<string, unknown>, max: number): string[] | undefined {
  if (body['images'] === undefined) return undefined;
  if (!Array.isArray(body['images']) || body['images'].length > max || !body['images'].every(x => typeof x === 'string' && /^[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/u.test(x))) throw new AppError('bad_request', 'field_type', { field: 'images' });
  return body['images'] as string[];
}
export function registerChatRoutes(router: Router, app: App): void {
  router.get('/api/chat/history', async ({ query }) => {
    const p = reqString(query, 'project', 100);
    const t = reqString(query, 'task', 100);
    const before = query.get('before');
    if (typeof before !== 'string' || !/^\d+$/u.test(before) || !Number.isSafeInteger(Number(before))) {
      throw new AppError('bad_request', 'field_type', { field: 'before' });
    }
    return app.runner.history(p, t, Number(before));
  });
  router.get('/api/chat/stream', async ({ query, req, res }) => {
    const p = reqString(query, 'project', 100); const t = reqString(query, 'task', 100);
    const snapshot = await app.runner.snapshot(p, t); app.runner.markRead(p, t);
    app.sse.open(req, res, taskKey(p, t), { event: 'snapshot', data: snapshot });
  });
  router.post('/api/chat/send', async ({ body, ip }) => {
    if (!app.sendLimiter.take(ip)) throw new AppError('too_many_requests');
    const mode = optString(body, 'mode', 20);
    if (mode && !SEND_MODES.includes(mode as typeof SEND_MODES[number])) throw new AppError('bad_request');
    if (body['answer'] !== undefined && typeof body['answer'] !== 'boolean') throw new AppError('bad_request');
    const input: SendInput = { project: reqString(body, 'project', 100), task: reqString(body, 'task', 100), text: optString(body, 'text', app.config.limits.promptChars) ?? '' };
    const ai = optString(body, 'ai', 100); const model = optString(body, 'model', 200); const effort = optString(body, 'effort', 20); const fromQueue = optString(body, 'fromQueue', 100); const pics = images(body, app.config.limits.imagesPerSend);
    if (ai) input.ai = ai; if (model) input.model = model; if (effort) input.effort = effort; if (mode) input.mode = mode as typeof SEND_MODES[number]; if (fromQueue) input.fromQueue = fromQueue; if (pics) input.images = pics; if (body['answer'] === true) input.answer = true;
    return app.runner.send(input);
  });
  router.post('/api/chat/stop', async ({ body }) => ({ stopped: await app.runner.stop(reqString(body, 'project', 100), reqString(body, 'task', 100)) }));
  router.post('/api/chat/unqueue', async ({ body }) => app.runner.unqueue(reqString(body, 'project', 100), reqString(body, 'task', 100), reqString(body, 'id', 100)));
  router.post('/api/start', async ({ body, ip }): Promise<StartResult> => {
    if (!app.sendLimiter.take(ip)) throw new AppError('too_many_requests');
    const p = reqString(body, 'project', 100); const project = await app.projects.get(p);
    const text = optString(body, 'text', app.config.limits.promptChars) ?? ''; const pics = images(body, app.config.limits.imagesPerSend);
    if (!text.trim() && !pics?.length) throw new AppError('bad_request');
    const ai = reqString(body, 'ai', 100); const model = optString(body, 'model', 200) ?? ''; const effort = optString(body, 'effort', 20) ?? '';
    const bodyPath = app.projects.bodyPath(project);
    const task = await app.tasks.create(p, { title: text.trim().split('\n')[0]?.slice(0, 40) || '看圖片', phase: app.projects.currentPhase(project), cli: ai, model, effort, workspace: bodyPath === app.ws.projectDir(p) || await isRepo(bodyPath) ? 'isolated' : 'direct' });
    await writeJson(app.ws.startPickFile(p), { ai, model, effort });
    const sent = await app.runner.send({ project: p, task: task.id, text, ai, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(pics ? { images: pics } : {}) });
    await app.oplog.record({ action: 'quickstart', project: p, task: task.id }); app.changed(p, task.id);
    return { task: await app.tasks.get(p, task.id), request: sent.request };
  });
  router.postRaw('/api/upload', app.config.limits.uploadBytes, async ({ query, raw }) => {
    const p = reqString(query, 'project', 100); await app.projects.get(p);
    return saveUpload(app.ws, p, reqString(query, 'name', 255), raw);
  });
  router.get('/api/upload', async ({ query, res }) => {
    const p = reqString(query, 'project', 100); await app.projects.get(p); const id = reqString(query, 'id', 100);
    let data: Buffer;
    try { data = await fs.readFile(uploadPath(app.ws, p, id)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found'); throw err; }
    res.writeHead(200, { 'Content-Type': IMAGE_TYPES[path.extname(id).slice(1)]!, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
  });
  router.get('/api/attachment', async ({ query, res }) => {
    const p = reqString(query, 'project', 100); const t = reqString(query, 'task', 100);
    await app.tasks.get(p, t); const name = reqString(query, 'name', 100);
    if (!/^[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/u.test(name)) throw new AppError('bad_request');
    let data: Buffer;
    try { data = await fs.readFile(path.join(app.ws.attachmentsDir(p, t), name)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found'); throw err; }
    res.writeHead(200, { 'Content-Type': IMAGE_TYPES[path.extname(name).slice(1)]!, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
  });
}
