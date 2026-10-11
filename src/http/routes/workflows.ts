import type { App } from '../../server/app.ts';
import type { WorkflowStep } from '../../shared/types.ts';
import { AppError } from '../../shared/errors.ts';
import { reqString, type Router } from '../router.ts';

export function registerWorkflowRoutes(router: Router, app: App): void {
  router.get('/api/task/workflow', async ({ query }) => app.workflows.get(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.post('/api/task/workflow/configure', async ({ body }) => {
    if (!Array.isArray(body.dependencies) || !body.dependencies.every(d => typeof d === 'string') || !Array.isArray(body.steps)) throw new AppError('bad_request', 'workflow_invalid');
    return app.workflows.configure(reqString(body, 'project', 120), reqString(body, 'task', 120), body.dependencies as string[], body.steps as WorkflowStep[]);
  });
  router.post('/api/task/workflow/start', async ({ body }) => app.workflows.start(reqString(body, 'project', 120), reqString(body, 'task', 120)));
  router.post('/api/task/workflow/stop', async ({ body }) => {
    await app.workflows.stop(reqString(body, 'project', 120), reqString(body, 'task', 120));
    return { ok: true };
  });
  router.post('/api/task/workflow/approve', async ({ body }) => app.workflows.approveHuman(reqString(body, 'project', 120), reqString(body, 'task', 120)));
}
