import { search } from '../../chat/search.ts';
import type { App } from '../../server/app.ts';
import type { Router } from '../router.ts';

export function registerSearchRoutes(router: Router, app: App): void {
  router.get('/api/search', async ({ query }) => search({
    projects: () => app.projects.list(),
    tasks: (project) => app.tasks.list(project),
    readLog: (project, task) => app.store.readLog(project, task),
  }, query.get('q')));
}
