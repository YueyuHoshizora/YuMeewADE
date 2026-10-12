import type { App } from '../../server/app.ts';
import type { WorkflowStep } from '../../shared/types.ts';
import { AppError } from '../../shared/errors.ts';
import { reqString, type Router } from '../router.ts';

export function registerWorkflowRoutes(router: Router, app: App): void {
  router.get('/api/task/workflow', async ({ query }) => app.workflows.get(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.get('/api/task/workflow/next', async ({ query }) => {
    const project = reqString(query, 'project', 120); const task = reqString(query, 'task', 120);
    const pick = await app.workflows.nextSelection(project, task);
    return pick ? { project, task, ai: pick.ai, account: (await app.settings.get()).activeAccounts[pick.ai] ?? 'default' } : null;
  });
  router.post('/api/task/workflow/configure', async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = reqString(body, 'task', 120);
    if (!Array.isArray(body.dependencies) || !body.dependencies.every(d => typeof d === 'string') || !Array.isArray(body.steps) || !Number.isSafeInteger(body.revision)) throw new AppError('bad_request', 'workflow_invalid');
    if (app.taskBusy(project, task)) throw new AppError('conflict', 'workflow_busy');
    return app.workflows.configure(project, task, body.dependencies as string[], body.steps as WorkflowStep[], body.revision as number);
  });
  router.post('/api/task/workflow/start', async ({ body, ip }) => {
    if (!app.sendLimiter.take(ip)) throw new AppError('too_many_requests');
    const project = reqString(body, 'project', 120); const task = reqString(body, 'task', 120);
    await app.trust.assertExecutable(project);
    if (app.taskBusy(project, task)) throw new AppError('conflict', 'workflow_busy');
    return app.workflows.start(project, task);
  });
  router.post('/api/task/workflow/stop', async ({ body }) => {
    await app.workflows.stop(reqString(body, 'project', 120), reqString(body, 'task', 120));
    return { ok: true };
  });
  router.post('/api/task/workflow/approve', async ({ body }) => {
    if (!Number.isSafeInteger(body.revision) || body.node !== undefined && typeof body.node !== 'string') throw new AppError('bad_request', 'workflow_invalid');
    return app.workflows.approveHuman(reqString(body, 'project', 120), reqString(body, 'task', 120), reqString(body, 'evidence', 10000), typeof body.node === 'string' ? body.node : undefined, body.revision as number);
  });
  router.post('/api/task/workflow/rerun', async ({ body }) => {
    if (typeof body.from !== 'number' || !Number.isSafeInteger(body.revision)) throw new AppError('bad_request', 'workflow_invalid');
    return app.workflows.rerun(reqString(body, 'project', 120), reqString(body, 'task', 120), body.from, body.revision as number);
  });
  router.post('/api/task/workflow/integration/resolve', async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = reqString(body, 'task', 120);
    if (!Number.isSafeInteger(body.revision)) throw new AppError('bad_request', 'workflow_invalid');
    await app.trust.assertExecutable(project);
    return app.workflows.resolveIntegration(project, task, reqString(body, 'node', 80), body.revision as number);
  });
}
