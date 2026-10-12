import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';

export function registerVerifyRoutes(router: Router, app: App): void {
  router.get('/api/task/verify', async ({ query }) => app.verify.status(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.get('/api/task/verify/history', async ({ query }) => app.verify.history(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.post('/api/task/verify', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const task = reqString(body, 'task', 120);
    await app.trust.assertExecutable(project);
    if (app.taskBusy(project, task)) throw new AppError('conflict');
    if (app.workflows.isBusy(project, task)) throw new AppError('conflict', 'workflow_busy');
    const result = await app.verify.run(project, task);
    await app.oplog.record({ action: 'verify', project, task, ok: result.ok, exitCode: result.exitCode, ms: result.ms });
    return result;
  });
}

export function registerTestExplorerRoutes(router: Router, app: App): void {
  router.get('/api/task/tests', async ({ query }) => app.testExplorer.state(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.post('/api/task/tests/cancel', async ({ body }) => {
    // Stopping stays available after the project is restricted, like every other stop.
    const project = reqString(body, 'project', 120), task = reqString(body, 'task', 120);
    if (!app.testExplorer.isRunning(project, task)) throw new AppError('conflict');
    app.verify.cancel(project, task);
    return { ok: true };
  });
  router.post('/api/task/tests/configure', async ({ body }) => {
    const project = reqString(body, 'project', 120), task = reqString(body, 'task', 120);
    await app.trust.assertExecutable(project);
    if (app.taskBusy(project, task)) throw new AppError('conflict');
    return app.testExplorer.save(project, task, body['configuration'], reqString(body, 'revision', 100));
  });
  router.post('/api/task/tests/run', async ({ body }) => {
    const project = reqString(body, 'project', 120), task = reqString(body, 'task', 120);
    await app.trust.assertExecutable(project);
    if (app.taskBusy(project, task)) throw new AppError('conflict');
    const runner = reqString(body, 'runner', 80);
    const selection = body['selection'] === undefined ? undefined : reqString(body, 'selection', 2000);
    const result = await app.testExplorer.run(project, task, runner, selection);
    await app.oplog.record({ action: 'verify', project, task, ok: result.result.ok, exitCode: result.result.exitCode, ms: result.result.ms });
    return result;
  });
}
