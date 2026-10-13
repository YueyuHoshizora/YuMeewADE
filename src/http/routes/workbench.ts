import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';
import { TaskLinkedFeedback } from '../../ledger/task-linked-feedback.ts';
import type { GithubFeedbackRemote, LinkedFeedback } from '../../shared/github.ts';

export function registerWorkbenchRoutes(router: Router, app: App): void {
  const feedback = new TaskLinkedFeedback(app.ws, app.tasks);
  const busy = (project: string, task?: string) => { if (app.taskBusy(project, task)) throw new AppError('conflict', 'task_busy'); };
  const text = (body: Record<string, unknown>, key: string, max: number): string => {
    const value = body[key]; if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new AppError('bad_request', 'field_type', { field: key }); return value;
  };
  const refreshed = (value: LinkedFeedback, remote: GithubFeedbackRemote): LinkedFeedback => ({ ...value, resolved: remote.thread?.resolved ?? false, state: remote.issue?.state ?? '', headOid: remote.headOid, ...(remote.issue?.contentVersion ? { contentVersion: remote.issue.contentVersion } : {}) });
  router.get('/api/git/linked-feedback', async ({ query }) => feedback.get(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.post('/api/git/feedback-task', async ({ body }) => {
    const project = reqString(body, 'project', 120); await app.trust.assertExecutable(project); busy(project);
    if (!Number.isSafeInteger(body.number) || (body.number as number) <= 0) throw new AppError('bad_request', 'field_type');
    const repository = reqString(body, 'repository', 200), threadId = reqString(body, 'threadId', 200), commentId = reqString(body, 'commentId', 200);
    const draft = text(body, 'draft', app.config.limits.promptChars);
    const remote = await app.gitWorkbench.githubFeedback(project, { action: 'feedback-read', repository, number: body.number as number, threadId, kind: 'thread' });
    const thread = remote.thread, source = thread?.comments.find(comment => comment.id === commentId);
    if (!thread || !source || !source.url || new URL(source.url).pathname !== `/${repository}/pull/${body.number}`) throw new AppError('conflict', 'gh_pr_failed');
    busy(project);
    const task = await app.tasks.create(project, { title: reqString(body, 'title', 300) });
    const linked = await feedback.create(project, task.id, { repository, kind: 'thread', number: body.number as number, url: source.url, threadId, commentId, path: thread.path, line: thread.line, source: source.body, draft, resolved: thread.resolved, state: '', headOid: remote.headOid });
    await app.oplog.record({ action: 'github.feedback-task', project, task: task.id }); app.changed(project, task.id);
    return { task, feedback: linked };
  });
  for (const operation of ['draft', 'refresh', 'reply', 'resolve', 'unresolve', 'update', 'close'] as const) router.post(`/api/git/feedback-${operation}`, async ({ body }) => {
    const project = reqString(body, 'project', 120), task = reqString(body, 'task', 120); busy(project, task);
    if (operation !== 'draft') await app.trust.assertExecutable(project);
    if (!['draft', 'refresh'].includes(operation) && body.confirmed !== true) throw new AppError('bad_request', 'git_confirm_required');
    const result = await feedback.change(project, task, reqString(body, 'revision', 100), async current => {
      busy(project, task);
      if (operation === 'draft') return { ...current, draft: text(body, 'draft', app.config.limits.promptChars) };
      const input = { repository: current.repository, number: current.number, threadId: current.threadId, kind: current.kind };
      const remote = operation === 'refresh'
        ? await app.gitWorkbench.githubFeedback(project, { action: 'feedback-read', ...input })
        : await app.gitWorkbench.githubFeedback(project, { action: 'feedback-write', ...input, commentId: current.commentId, ...(current.contentVersion ? { expectedContentVersion: current.contentVersion } : {}), operation, headOid: current.headOid, expectedResolved: current.resolved, expectedState: current.state, body: body.body === undefined ? '' : text(body, 'body', 10000), title: body.title === undefined ? '' : text(body, 'title', 300), confirmed: true });
      return refreshed(current, remote);
    });
    await app.oplog.record({ action: `github.feedback-${operation}`, project, task }); app.changed(project, task);
    return result;
  });
  router.get('/api/git/status', async ({ query }) => app.gitWorkbench.status(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  router.get('/api/git/remotes', async ({ query }) => app.gitWorkbench.remotes(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined));
  for (const operation of ['remote', 'manage-branch'] as const) router.post(`/api/git/${operation}`, async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = body.task === undefined ? undefined : reqString(body, 'task', 120);
    for (const key of ['push', 'force', 'confirmed', 'forceConfirmed']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new AppError('bad_request');
    const action = reqString(body, 'action', 30); const name = reqString(body, 'name', operation === 'remote' ? 100 : 200);
    const newName = body.newName === undefined ? undefined : reqString(body, 'newName', operation === 'remote' ? 100 : 200);
    if (operation === 'remote') await app.gitWorkbench.remote(project, task, action, name, { ...(newName === undefined ? {} : { newName }), ...(body.url === undefined ? {} : { url: reqString(body, 'url', 2048) }), push: body.push === true, confirmed: body.confirmed === true });
    else await app.gitWorkbench.manageBranch(project, task, action, name, { ...(newName === undefined ? {} : { newName }), force: body.force === true, confirmed: body.confirmed === true, forceConfirmed: body.forceConfirmed === true });
    await app.oplog.record({ action: `git.${operation}.${action}`, project, ...(task ? { task } : {}) });
    app.changed(project, task); return { ok: true };
  });
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
    await app.trust.assertExecutable(project); busy(project);
    if (!Number.isSafeInteger(body.number) || (body.number as number) <= 0) throw new AppError('bad_request', 'field_type', { field: 'number' });
    const issue = await app.gitWorkbench.issue(project, body.number as number);
    const status = await app.gitWorkbench.pullRequestStatus(project);
    if (!status.repository || new URL(issue.url).pathname !== `/${status.repository}/issues/${issue.number}`) throw new AppError('conflict', 'gh_pr_failed');
    const draft = body.draft === undefined ? `${issue.title}\n${issue.url}\n\n${issue.body}`.slice(0, app.config.limits.promptChars) : text(body, 'draft', app.config.limits.promptChars);
    busy(project);
    const task = await app.tasks.create(project, { title: reqString(body, 'title', 300), issue: issue.number, issueUrl: issue.url });
    const linked = await feedback.create(project, task.id, { repository: status.repository, kind: 'issue', number: issue.number, url: issue.url, threadId: '', commentId: '', path: '', line: null, source: issue.body, draft, resolved: false, state: issue.state, headOid: '', ...(issue.contentVersion ? { contentVersion: issue.contentVersion } : {}) });
    await app.oplog.record({ action: 'github.issue-task', project, task: task.id });
    app.changed(project, task.id);
    return { task, feedback: linked };
  });
  router.get('/api/git/diff', async ({ query }) => app.gitWorkbench.diff(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'path', 1000), query.get('staged') === 'true'));
  router.get('/api/git/diff-contents', async ({ query }) => app.gitWorkbench.diffContents(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'path', 1000), reqString(query, 'mode', 20)));
  router.get('/api/git/conflict', async ({ query }) => app.gitWorkbench.conflict(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'path', 1000)));
  router.get('/api/git/compare-options', async ({ query }) => (await app.tasks.list(reqString(query, 'project', 120))).filter(task => task.workdir || task.workspace === 'direct').map(task => ({ id: task.id, title: task.title })));
  router.get('/api/git/compare-tasks', async ({ query }) => app.gitWorkbench.compareTasks(reqString(query, 'project', 120), reqString(query, 'leftTask', 120), reqString(query, 'rightTask', 120)));
  router.get('/api/git/history', async ({ query }) => app.gitWorkbench.history(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, Number(query.get('skip') ?? 0), query.has('path') ? reqString(query, 'path', 1000) : undefined));
  router.get('/api/git/commit-detail', async ({ query }) => app.gitWorkbench.commitDetail(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'sha', 64)));
  router.get('/api/git/blame', async ({ query }) => ({ lines: await app.gitWorkbench.blame(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : undefined, reqString(query, 'path', 1000)) }));
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
  for (const action of ['stage', 'unstage', 'discard', 'resolve', 'commit', 'fetch', 'pull', 'branch', 'push', 'pr'] as const) {
    router.post(`/api/git/${action}`, async ({ body }) => {
      const project = reqString(body, 'project', 120);
      const task = body.task === undefined ? undefined : reqString(body, 'task', 120);
      let result: unknown = { ok: true };
      switch (action) {
        case 'stage': case 'unstage': await app.gitWorkbench.stage(project, task, reqString(body, 'path', 1000), action === 'unstage'); break;
        case 'discard': await app.gitWorkbench.discard(project, task, reqString(body, 'path', 1000), reqString(body, 'fingerprint', 64)); break;
        case 'pull': result = await app.gitWorkbench.fastForward(project, task); break;
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
