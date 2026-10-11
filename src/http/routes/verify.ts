import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';

export function registerVerifyRoutes(router: Router, app: App): void {
  router.get('/api/task/verify', async ({ query }) => app.verify.status(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.post('/api/task/verify', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const task = reqString(body, 'task', 120);
    if (app.workflows.isBusy(project, task)) throw new AppError('conflict', 'workflow_busy');
    const result = await app.verify.run(project, task);
    await app.oplog.record({ action: 'verify', project, task, ok: result.ok, exitCode: result.exitCode, ms: result.ms });
    return result;
  });
}
