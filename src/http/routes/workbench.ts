import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';

export function registerWorkbenchRoutes(router: Router, app: App): void {
  router.get('/api/git/status', async ({ query }) => app.gitWorkbench.status(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  router.get('/api/git/pr-status', async ({ query }) => app.gitWorkbench.pullRequestStatus(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  for (const action of ['stage', 'unstage', 'resolve', 'commit', 'fetch', 'branch', 'push', 'pr'] as const) {
    router.post(`/api/git/${action}`, async ({ body }) => {
      const project = reqString(body, 'project', 120);
      const task = body.task === undefined ? undefined : reqString(body, 'task', 120);
      let result: unknown = { ok: true };
      switch (action) {
        case 'stage': case 'unstage': await app.gitWorkbench.stage(project, task, reqString(body, 'path', 1000), action === 'unstage'); break;
        case 'resolve': await app.gitWorkbench.resolve(project, task, reqString(body, 'path', 1000)); break;
        case 'commit': result = await app.gitWorkbench.commit(project, task, reqString(body, 'message', 10_000)); break;
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
