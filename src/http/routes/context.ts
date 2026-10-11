import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { reqString, type Router } from '../router.ts';
import { readContext, saveContext, validateContext } from '../../chat/context.ts';
import { draftImagePath, readDraft, updateDraft, validateReviews } from '../../chat/drafts.ts';
import { IMAGE_TYPES } from '../../chat/attachments.ts';

export function registerContextRoutes(router: Router, app: App): void {
  async function scope(project: string, task: string): Promise<void> {
    await app.projects.get(project);
    if (task !== 'quickstart') await app.tasks.get(project, task);
  }
  router.get('/api/task/context', async ({ query }) => {
    const project = reqString(query, 'project', 100); const task = reqString(query, 'task', 100);
    await app.tasks.get(project, task); return readContext(app.ws, project, task);
  });
  router.post('/api/task/context', async ({ body }) => {
    const project = reqString(body, 'project', 100); const task = reqString(body, 'task', 100);
    await app.tasks.get(project, task);
    const value = validateContext(body['context'], app.config.limits.handoffChars);
    await saveContext(app.ws, project, task, value); return value;
  });
  router.get('/api/task/handoff', async ({ query }) => app.runner.contextPreview(reqString(query, 'project', 100), reqString(query, 'task', 100), reqString(query, 'ai', 100), query.get('model') ?? ''));
  router.get('/api/chat/draft', async ({ query }) => {
    const project = reqString(query, 'project', 100); const task = reqString(query, 'scope', 100);
    await scope(project, task);
    const draft = await readDraft(app.ws, project, task);
    return { ...draft, images: draft.images.map(image => ({ ...image, url: `/api/chat/draft-image?${new URLSearchParams({ project, scope: task, id: image.id })}` })) };
  });
  router.post('/api/chat/draft', async ({ body }) => {
    const project = reqString(body, 'project', 100); const task = reqString(body, 'scope', 100);
    await scope(project, task);
    const reviews = body['reviews'] === undefined ? undefined : validateReviews(body['reviews']);
    const remove = body['remove'];
    if (remove !== undefined && (!Array.isArray(remove) || remove.length > app.config.limits.imagesPerSend || !remove.every(id => typeof id === 'string'))) throw new AppError('bad_request');
    return updateDraft(app.ws, project, task, draft => {
      if (reviews !== undefined) draft.reviews = reviews;
      if (Array.isArray(remove)) draft.images = draft.images.filter(image => !remove.includes(image.id));
    });
  });
  router.get('/api/chat/draft-image', async ({ query, res }) => {
    const project = reqString(query, 'project', 100); const task = reqString(query, 'scope', 100);
    await scope(project, task);
    const file = await draftImagePath(app.ws, project, task, reqString(query, 'id', 100));
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': IMAGE_TYPES[path.extname(file).slice(1)]!, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
  });
}
