import type { App } from '../../server/app.ts';
import type { ProjectTrustPatch } from '../../shared/types.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, optString, reqString } from '../router.ts';

export function registerTrustRoutes(router: Router, app: App): void {
  router.get('/api/project/trust', async ({ query }) => app.trust.view(reqString(query, 'project', 120), optString(query, 'task', 120)));
  router.post('/api/project/trust', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    if (app.taskBusy(project)) throw new AppError('conflict', 'git_workbench_running');
    const result = await app.trust.update(project, body as unknown as ProjectTrustPatch);
    await app.oplog.record({ action: 'project.trust', project, state: result.state });
    app.changed(project);
    return result;
  });
}
