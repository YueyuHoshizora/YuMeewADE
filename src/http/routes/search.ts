import { search } from '../../chat/search.ts';
import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { optString, type Router } from '../router.ts';

export function registerSearchRoutes(router: Router, app: App): void {
  router.get('/api/search', async ({ query }) => {
    const project = optString(query, 'project', 100); const task = optString(query, 'task', 100);
    if (task && !project) throw new AppError('bad_request', 'field_required', { field: 'project' });
    // Scopes go through the ledger getters, which validate the names and reject unknown or archived entries.
    const scopedProject = project ? await app.projects.get(project) : undefined;
    const scopedTask = project && task ? await app.tasks.get(project, task) : undefined;
    return search({
      projects: async () => scopedProject ? [scopedProject] : app.projects.list(),
      tasks: async (id) => scopedTask ? [scopedTask] : app.tasks.list(id),
      readLog: (id, taskId) => app.store.readLog(id, taskId),
      // A task archived between listing and reading has no record left to search.
      sections: (id, taskId) => app.tasks.sections(id, taskId).catch((err: unknown) => {
        if (err instanceof AppError && err.detail === 'task_missing') return { done: [], next: [], cautions: [], memo: [] };
        throw err;
      }),
    }, query.get('q'));
  });
}
