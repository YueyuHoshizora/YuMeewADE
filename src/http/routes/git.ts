import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { rankFiles } from '../../shared/file-match.ts';
import { Router, reqString, optString } from '../router.ts';

export function registerGitRoutes(router: Router, app: App): void {
  router.get('/api/git/worktrees', async ({ query }) => app.worktree.maintenance(reqString(query, 'project', 120)));
  router.get('/api/git/worktrees/prune-preview', async ({ query }) => ({ preview: await app.worktree.prunePreview(reqString(query, 'project', 120)) }));
  router.post('/api/git/worktrees/prune', async ({ body }) => {
    if (body.confirmed !== true) throw new AppError('bad_request', 'field_type', { field: 'confirmed' });
    const project = reqString(body, 'project', 120);
    if (typeof body.preview !== 'string' || body.preview.length > 100_000) throw new AppError('bad_request', 'field_type', { field: 'preview' });
    await app.worktree.pruneStale(project, body.preview);
    app.changed(project); return { ok: true };
  });
  router.post('/api/git/worktrees/remove', async ({ body }) => {
    if (body.confirmed !== true) throw new AppError('bad_request', 'field_type', { field: 'confirmed' });
    const project = reqString(body, 'project', 120);
    await app.worktree.removeStale(project, reqString(body, 'path', 4000));
    app.changed(project); return { ok: true };
  });
  router.get('/api/task/preview', async ({ query }) => app.worktree.preview(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.get('/api/task/diff', async ({ query }) => app.worktree.diff(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.post('/api/task/merge', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const task = reqString(body, 'task', 120);
    if (app.taskBusy(project, task)) throw new AppError('conflict', 'merge_while_running');
    const result = await app.worktree.merge(project, task, async () => {
      if (app.taskBusy(project, task)) throw new AppError('conflict', 'merge_while_running');
      await app.verify.requireCurrentPass(project, task);
      await app.review.assertMergeAllowed(project, task);
    });
    app.changed(project, task);
    return result;
  });
  router.get('/api/task/merged', async ({ query }) => app.worktree.mergedInfo(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.post('/api/task/unmerge', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const task = reqString(body, 'task', 120);
    if (app.taskBusy(project, task)) throw new AppError('conflict', 'merge_while_running');
    const result = await app.worktree.unmerge(project, task);
    app.changed(project, task);
    return result;
  });
  router.get('/api/task/files', async ({ query }) => {
    const project = reqString(query, 'project', 120);
    await app.trust.assertExecutable(project);
    const hits = rankFiles(await app.worktree.listFiles(project, optString(query, 'task', 120) ?? ''), (query.get('q') ?? '').slice(0, 200));
    return { files: hits.slice(0, 50), total: hits.length };
  });
  router.get('/api/task/file', async ({ query }) => {
    const project = reqString(query, 'project', 120);
    await app.trust.assertExecutable(project);
    return app.worktree.readFile(project, optString(query, 'task', 120) ?? '', reqString(query, 'path', 1000));
  });
  router.post('/api/task/revert-file', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const task = reqString(body, 'task', 120);
    if (app.taskBusy(project, task)) throw new AppError('conflict', 'rollback_while_running');
    await app.worktree.revertFile(project, task, reqString(body, 'path', 1000));
    await app.oplog.record({ action: 'task.revert-file', project, task });
    app.verify.invalidate(project, task);
    app.changed(project, task);
    return { ok: true };
  });
  router.post('/api/task/merge-exclusion', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const task = reqString(body, 'task', 120);
    if (app.taskBusy(project, task)) throw new AppError('conflict', 'merge_while_running');
    if (typeof body.excluded !== 'boolean') throw new AppError('bad_request');
    const result = await app.worktree.exclusion(project, task, body.excluded);
    await app.oplog.record({ action: 'task.merge-exclusion', project, task, excluded: body.excluded });
    app.changed(project, task);
    return result;
  });
  router.post('/api/task/copyclear', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const task = reqString(body, 'task', 120);
    if (app.taskBusy(project, task)) throw new AppError('conflict', 'remove_while_running');
    const result = await app.worktree.copyclear(project, task);
    await app.oplog.record({ action: 'task.copyclear', project, task });
    app.changed(project, task);
    return result;
  });
}
