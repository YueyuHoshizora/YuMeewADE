import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';

export function registerArchiveRoutes(router: Router, app: App): void {
  router.get('/api/archive/list', async ({ query }) => app.archive.list(query.has('project') ? reqString(query, 'project', 120) : undefined));
  router.get('/api/archive/preview', async ({ query }) => app.archive.preview(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  router.post('/api/archive/restore', async ({ body }) => {
    const key = reqString(body, 'key', 160);
    const project = body.project === undefined ? undefined : reqString(body, 'project', 120);
    const selected = (await app.archive.list(project)).find(item => item.key === key);
    if (!selected) throw new AppError('not_found', 'archive_missing');
    if (app.taskBusy(selected.project, selected.task || undefined)) throw new AppError('conflict', 'archive_while_running');
    const entry = await app.archive.restore(key, project);
    await app.oplog.record({ action: 'archive.restore', project: entry.project, ...(entry.task ? { task: entry.task } : {}) });
    app.changed(entry.project, entry.task || undefined);
    return entry;
  });
}
