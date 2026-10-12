import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { MEMORY_MAX_BYTES } from '../../ledger/memory.ts';
import { Router, reqString } from '../router.ts';

export function registerMemoryRoutes(router: Router, app: App): void {
  router.get('/api/project/memory', async ({ query }) => {
    const project = reqString(query, 'project', 120);
    const name = query.get('name');
    return name === null ? { files: await app.memory.list(project) } : app.memory.read(project, name);
  });
  router.post('/api/project/memory', async ({ body }) => {
    const project = reqString(body, 'project', 120); const name = reqString(body, 'name', 120);
    if (app.runner.isBusy(project)) throw new AppError('conflict', 'editor_running');
    if (body.revision !== null && typeof body.revision !== 'string') throw new AppError('bad_request');
    if (typeof body.text !== 'string') throw new AppError('bad_request', 'field_type', { field: 'text' });
    if (body.text.length > MEMORY_MAX_BYTES) throw new AppError('bad_request', 'field_too_long', { field: 'text' });
    const result = await app.memory.save(project, name, body.text, body.revision as string | null);
    await app.oplog.record({ action: 'project.memory.save', project }); app.changed(project);
    return result;
  });
  router.post('/api/project/memory/delete', async ({ body }) => {
    if (body.confirm !== true) throw new AppError('bad_request');
    const project = reqString(body, 'project', 120);
    if (app.runner.isBusy(project)) throw new AppError('conflict', 'editor_running');
    await app.memory.remove(project, reqString(body, 'name', 120), reqString(body, 'revision', 64));
    await app.oplog.record({ action: 'project.memory.delete', project }); app.changed(project);
    return { ok: true };
  });
}
