import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';
export function registerEditorRoutes(router: Router, app: App): void {
  router.get('/api/editor/file', async ({ query }) => app.editor.read(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : '', reqString(query, 'path', 1000)));
  router.post('/api/editor/save', async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = body.task === undefined ? '' : reqString(body, 'task', 120);
    if (app.taskBusy(project, task || undefined)) throw new AppError('conflict', 'editor_running');
    if (typeof body.text !== 'string') throw new AppError('bad_request');
    const result = await app.editor.save(project, task, reqString(body, 'path', 1000), body.text, reqString(body, 'revision', 100));
    if (task) app.verify.invalidate(project, task); app.changed(project, task || undefined);
    return result;
  });
  router.post('/api/editor/language', async ({ body }) => {
    const action = body.action;
    if (action !== 'definition' && action !== 'references' && action !== 'diagnostics') throw new AppError('bad_request');
    if (typeof body.text !== 'string' || !Number.isSafeInteger(body.line) || !Number.isSafeInteger(body.character) || (body.line as number) < 0 || (body.character as number) < 0) throw new AppError('bad_request');
    return app.editor.language(reqString(body, 'project', 120), body.task === undefined ? '' : reqString(body, 'task', 120), reqString(body, 'path', 1000), body.text, body.line as number, body.character as number, action);
  });
}
