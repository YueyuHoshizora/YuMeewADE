// API 路由（PLAN.md 4.1 與 A.6）。這裡只做輸入驗證與轉呼叫，不含業務邏輯。

import type { App } from '../server/app.ts';
import { AppError } from '../shared/errors.ts';
import type { Bootstrap, ProjectStatus, TaskPatch } from '../shared/types.ts';
import { optString, reqString, type Router } from './router.ts';
import { GLOBAL } from './sse.ts';

const NAME_MAX = 64;
const TITLE_MAX = 200;

export function registerRoutes(router: Router, app: App): void {
  router.get('/api/bootstrap', async (): Promise<Bootstrap> => {
    const [projects, roles, clis] = await Promise.all([app.projects.list(), app.roles(), app.cliInfo()]);
    return {
      version: app.version,
      projects,
      clis,
      roles,
      limits: {
        promptChars: app.config.limits.promptChars,
        queueLength: app.config.limits.queueLength,
        concurrentRuns: app.config.limits.concurrentRuns,
      },
      workspaceRoot: app.ws.root,
    };
  });

  router.get('/api/roles', () => app.roles());

  router.get('/api/tasks', async ({ query }) => {
    const project = reqString(query, 'project', NAME_MAX);
    await app.projects.get(project);
    return app.tasks.list(project);
  });

  router.post('/api/projects', async ({ body }) => app.projects.create(reqString(body, 'name', NAME_MAX)));

  router.post('/api/tasks', async ({ body }) => {
    const project = reqString(body, 'project', NAME_MAX);
    const title = reqString(body, 'title', TITLE_MAX);
    const role = optString(body, 'role', NAME_MAX) ?? '';
    await app.projects.get(project);
    if (role) {
      const roles = await app.roles();
      if (!roles.roles[role]) throw new AppError('bad_request', 'role 不存在');
    }
    return app.tasks.create(project, title, role);
  });

  router.post('/api/task/update', async ({ body }) => {
    const project = reqString(body, 'project', NAME_MAX);
    const task = reqString(body, 'task', NAME_MAX);
    const raw = body['patch'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('bad_request', 'patch 必須是物件');
    const patch: TaskPatch = {};
    for (const key of ['title', 'state', 'phase', 'owner', 'role', 'cli', 'model', 'effort', 'question'] as const) {
      const v = (raw as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (typeof v !== 'string') throw new AppError('bad_request', `${key} 必須是字串`);
      (patch as Record<string, string>)[key] = v;
    }
    await app.projects.get(project);
    const updated = await app.tasks.update(project, task, patch);
    app.publishTask(project, updated);
    return updated;
  });

  router.post('/api/project/update', async ({ body }) => {
    const project = reqString(body, 'project', NAME_MAX);
    const raw = body['patch'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('bad_request', 'patch 必須是物件');
    const status = (raw as Record<string, unknown>)['status'];
    if (status !== undefined && typeof status !== 'string') throw new AppError('bad_request', 'status 必須是字串');
    const updated = await app.projects.update(project, status === undefined ? {} : { status: status as ProjectStatus });
    app.publishProject(updated);
    return updated;
  });

  router.get('/api/events', async ({ req, res }) => {
    app.sse.open(req, res, GLOBAL, { event: 'ready', data: { version: app.version } });
    return undefined;
  });

  // ---- 對話 ----

  const locate = async (src: Record<string, unknown> | URLSearchParams): Promise<{ project: string; task: string }> => {
    const project = reqString(src, 'project', NAME_MAX);
    const task = reqString(src, 'task', NAME_MAX);
    await app.tasks.get(project, task);
    return { project, task };
  };

  router.get('/api/chat/log', async ({ query }) => {
    const { project, task } = await locate(query);
    return app.store.readLog(project, task);
  });

  router.get('/api/chat/stream', async ({ req, res, query }) => {
    const { project, task } = await locate(query);
    const [snap, taskDoc] = await Promise.all([app.runner.snapshot(project, task), app.tasks.get(project, task)]);
    app.sse.open(req, res, `${project}\u0000${task}`, { event: 'ready', data: { ...snap, task: taskDoc } });
    return undefined;
  });

  router.post('/api/chat/send', async ({ body, ip }) => {
    const { project, task } = await locate(body);
    const text = reqString(body, 'text', app.config.limits.promptChars);
    const cli = optString(body, 'cli', 32);
    const model = optString(body, 'model', 100);
    const effort = optString(body, 'effort', 16);
    if (!app.sendLimiter.take(ip)) throw new AppError('too_many_requests');
    return app.runner.send(project, task, text, { ...(cli ? { cli } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  });

  router.post('/api/chat/stop', async ({ body }) => {
    const { project, task } = await locate(body);
    return { stopped: app.runner.stop(project, task) };
  });

  router.post('/api/chat/queue/remove', async ({ body }) => {
    const { project, task } = await locate(body);
    return app.runner.removeQueued(project, task, reqString(body, 'request', 64));
  });

  router.post('/api/chat/queue/move-first', async ({ body }) => {
    const { project, task } = await locate(body);
    return app.runner.moveQueuedFirst(project, task, reqString(body, 'request', 64));
  });

  // ---- worktree ----

  router.get('/api/worktree/status', async ({ query }) => {
    const { project, task } = await locate(query);
    return app.worktree.status(project, task);
  });

  router.get('/api/worktree/diff', async ({ query }) => {
    const { project, task } = await locate(query);
    return app.worktree.diff(project, task);
  });

  router.post('/api/worktree/create', async ({ body }) => {
    const { project, task } = await locate(body);
    await app.worktree.ensure(project, task);
    return app.worktree.status(project, task);
  });

  router.post('/api/worktree/merge', async ({ body }) => {
    const { project, task } = await locate(body);
    if (app.runner.isRunning(project, task)) throw new AppError('conflict', '作業執行中，請先停止再收編');
    const t = await app.tasks.get(project, task);
    return app.worktree.merge(project, task, t.title);
  });

  router.post('/api/worktree/remove', async ({ body }) => {
    const { project, task } = await locate(body);
    if (app.runner.isRunning(project, task)) throw new AppError('conflict', '作業執行中，不能移除副本');
    await app.worktree.remove(project, task);
    return { removed: true };
  });
}
