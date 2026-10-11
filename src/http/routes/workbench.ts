import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';

export function registerWorkbenchRoutes(router: Router, app: App): void {
  router.get('/api/git/status', async ({ query }) => app.gitWorkbench.status(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  router.get('/api/git/pr-status', async ({ query }) => app.gitWorkbench.pullRequestStatus(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  router.get('/api/git/pr-review', async ({ query }) => app.gitWorkbench.pullRequestReview(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  router.get('/api/git/issues', async ({ query }) => app.gitWorkbench.issues(reqString(query, 'project', 120), query.has('search') ? reqString(query, 'search', 300) : ''));
  router.get('/api/git/issue', async ({ query }) => {
    const number = Number(reqString(query, 'number', 20));
    if (!Number.isSafeInteger(number) || number <= 0) throw new AppError('bad_request', 'field_type', { field: 'number' });
    return app.gitWorkbench.issue(reqString(query, 'project', 120), number);
  });
  router.post('/api/git/issue-task', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    if (!Number.isSafeInteger(body.number) || (body.number as number) <= 0) throw new AppError('bad_request', 'field_type', { field: 'number' });
    const issue = await app.gitWorkbench.issue(project, body.number as number);
    const task = await app.tasks.create(project, { title: reqString(body, 'title', 300), issue: issue.number, issueUrl: issue.url });
    await app.oplog.record({ action: 'github.issue-task', project, task: task.id });
    app.changed(project, task.id);
    return { task };
  });
  router.get('/api/git/diff', async ({ query }) => app.gitWorkbench.diff(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'path', 1000), query.get('staged') === 'true'));
  router.get('/api/git/conflict', async ({ query }) => app.gitWorkbench.conflict(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'path', 1000)));
  router.get('/api/git/compare-options', async ({ query }) => (await app.tasks.list(reqString(query, 'project', 120))).filter(task => task.workdir || task.workspace === 'direct').map(task => ({ id: task.id, title: task.title })));
  router.get('/api/git/compare-tasks', async ({ query }) => app.gitWorkbench.compareTasks(reqString(query, 'project', 120), reqString(query, 'leftTask', 120), reqString(query, 'rightTask', 120)));
  router.get('/api/git/history', async ({ query }) => app.gitWorkbench.history(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, Number(query.get('skip') ?? 0), query.has('path') ? reqString(query, 'path', 1000) : undefined));
  router.get('/api/git/commit-detail', async ({ query }) => app.gitWorkbench.commitDetail(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'sha', 64)));
  router.get('/api/git/blame', async ({ query }) => ({ text: await app.gitWorkbench.blame(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'path', 1000)) }));
  router.get('/api/git/stashes', async ({ query }) => app.gitWorkbench.stashes(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  for (const operation of ['stash', 'rewrite'] as const) router.post(`/api/git/${operation}`, async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = body.task === undefined ? undefined : reqString(body, 'task', 120);
    if (body.includeUntracked !== undefined && typeof body.includeUntracked !== 'boolean') throw new AppError('bad_request');
    const action = reqString(body, 'action', 30);
    const result = operation === 'stash'
      ? await app.gitWorkbench.stash(project, task, action, { ...(body.sha === undefined ? {} : { sha: reqString(body, 'sha', 64) }), ...(body.message === undefined ? {} : { message: reqString(body, 'message', 10_000) }), includeUntracked: body.includeUntracked === true, confirmed: body.confirmed === true })
      : await app.gitWorkbench.rewrite(project, task, action, typeof body.target === 'string' ? body.target : '', body.confirmed === true);
    await app.oplog.record({ action: `git.${operation}.${action}`, project, ...(task ? { task } : {}) });
    if (task) app.verify.invalidate(project, task);
    app.changed(project, task); return result ?? { ok: true };
  });
  router.post('/api/git/stage-lines', async ({ body }) => {
    if (typeof body.staged !== 'boolean' || !Array.isArray(body.lines) || body.lines.length > 100_000 || body.lines.some((line: unknown) => typeof line !== 'number' || !Number.isSafeInteger(line))) throw new AppError('bad_request');
    const project = reqString(body, 'project', 120); const task = body.task === undefined ? undefined : reqString(body, 'task', 120);
    await app.gitWorkbench.stageLines(project, task, reqString(body, 'path', 1000), body.staged, reqString(body, 'fingerprint', 64), body.lines as number[]);
    await app.oplog.record({ action: 'git.stage-lines', project, ...(task ? { task } : {}) });
    if (task) app.verify.invalidate(project, task);
    app.changed(project, task);
    return { ok: true };
  });
  for (const action of ['stage', 'unstage', 'resolve', 'commit', 'fetch', 'branch', 'push', 'pr'] as const) {
    router.post(`/api/git/${action}`, async ({ body }) => {
      const project = reqString(body, 'project', 120);
      const task = body.task === undefined ? undefined : reqString(body, 'task', 120);
      let result: unknown = { ok: true };
      switch (action) {
        case 'stage': case 'unstage': await app.gitWorkbench.stage(project, task, reqString(body, 'path', 1000), action === 'unstage'); break;
        case 'resolve': await app.gitWorkbench.resolve(project, task, reqString(body, 'path', 1000)); break;
        case 'commit':
          if (body.bypassHooks !== undefined && typeof body.bypassHooks !== 'boolean') throw new AppError('bad_request');
          result = await app.gitWorkbench.commit(project, task, reqString(body, 'message', 10_000), { bypassHooks: body.bypassHooks === true, confirmed: body.confirmed === true }); break;
        case 'fetch': await app.gitWorkbench.fetch(project, task, reqString(body, 'remote', 100)); break;
        case 'branch':
          if (typeof body.create !== 'boolean') throw new AppError('bad_request');
          await app.gitWorkbench.branch(project, task, reqString(body, 'name', 200), body.create); break;
        case 'push': await app.gitWorkbench.push(project, task, reqString(body, 'remote', 100), body.confirmed === true); break;
        case 'pr':
          if (typeof body.body !== 'string') throw new AppError('bad_request', 'git_pr_invalid');
          result = await app.gitWorkbench.pullRequest(project, task, { title: reqString(body, 'title', 300), body: body.body, base: reqString(body, 'base', 200), head: reqString(body, 'head', 200), confirmed: body.confirmed === true }); break;
      }
      await app.oplog.record({ action: `git.${action}`, project, ...(task ? { task } : {}) });
      if (task) app.verify.invalidate(project, task);
      app.changed(project, task);
      return result;
    });
  }
}
