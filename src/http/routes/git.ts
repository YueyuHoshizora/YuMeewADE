import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';

export function registerGitRoutes(router: Router, app: App): void {
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
    const needle = (query.get('q') ?? '').toLowerCase().slice(0, 200);
    const all = await app.worktree.listFiles(reqString(query, 'project', 120), reqString(query, 'task', 120));
    const base = (file: string) => file.slice(file.lastIndexOf('/') + 1).toLowerCase();
    const hits = needle ? all.filter(file => file.toLowerCase().includes(needle)) : all;
    hits.sort((a, b) => Number(!base(a).startsWith(needle)) - Number(!base(b).startsWith(needle)) || a.length - b.length || a.localeCompare(b));
    return { files: hits.slice(0, 50), total: hits.length };
  });
  router.get('/api/task/file', async ({ query }) => app.worktree.readFile(reqString(query, 'project', 120), reqString(query, 'task', 120), reqString(query, 'path', 1000)));
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
