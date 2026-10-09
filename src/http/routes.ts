// API 路由（PLAN.md 4.1 與 A.6）。這裡只做輸入驗證與轉呼叫，不含業務邏輯。

import type { App } from '../server/app.ts';
import { AppError } from '../shared/errors.ts';
import type { Bootstrap, TaskPatch } from '../shared/types.ts';
import { optString, reqString, type Router } from './router.ts';

const NAME_MAX = 64;
const TITLE_MAX = 200;

export function registerRoutes(router: Router, app: App): void {
  router.get('/api/bootstrap', async (): Promise<Bootstrap> => {
    const [projects, roles] = await Promise.all([app.projects.list(), app.roles()]);
    return {
      version: app.version,
      projects,
      clis: [],
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
    return app.tasks.update(project, task, patch);
  });
}
