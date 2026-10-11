import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { reqString, optString, type Router } from '../router.ts';

export function registerReviewRoutes(router: Router, app: App): void {
  router.get('/api/review/capabilities', async () => ({ providers: app.review.capabilities() }));
  router.post('/api/review/run', async ({ body, ip }) => {
    if (!app.sendLimiter.take(ip)) throw new AppError('too_many_requests');
    const project = reqString(body, 'project', 100); const task = reqString(body, 'task', 100);
    if (app.workflows.isBusy(project, task)) throw new AppError('conflict', 'workflow_busy');
    const model = optString(body, 'model', 200); const effort = optString(body, 'effort', 20);
    return app.review.run(project, task, {
      ai: reqString(body, 'ai', 100), text: reqString(body, 'text', app.config.limits.promptChars),
      ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }),
    });
  });
  router.post('/api/review/stop', async ({ body }) => ({ stopped: app.review.stop(reqString(body, 'project', 100), reqString(body, 'task', 100)) }));
}
