import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';
export function registerEditorProposalRoutes(router: Router, app: App): void {
  router.get('/api/editor/proposals', async ({ query }) => ({ proposals: await app.editorProposals.history(reqString(query, 'project', 120), query.get('task') ?? '') }));
  router.post('/api/editor/proposals/generate', async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = body.task === undefined || body.task === '' ? '' : reqString(body, 'task', 120);
    await app.trust.assertExecutable(project);
    if (app.taskBusy(project, task || undefined)) throw new AppError('conflict', 'editor_running');
    if (!body.selection || typeof body.selection !== 'object' || Array.isArray(body.selection) || !('from' in body.selection) || !('to' in body.selection) || typeof body.selection.from !== 'number' || typeof body.selection.to !== 'number' || typeof body.text !== 'string') throw new AppError('bad_request');
    return app.editorProposals.generate(project, task, { path: reqString(body, 'path', 1000), revision: reqString(body, 'revision', 100), text: body.text, selection: { from: body.selection.from, to: body.selection.to }, instruction: reqString(body, 'instruction', 100_000), ai: reqString(body, 'ai', 20), ...(body.model === undefined ? {} : { model: reqString(body, 'model', 200) }), ...(body.effort === undefined ? {} : { effort: reqString(body, 'effort', 100) }) });
  });
  router.post('/api/editor/proposals/decide', async ({ body }) => {
    if (typeof body.accept !== 'boolean' || typeof body.text !== 'string' || body.text.length > 262_144 || typeof body.version !== 'number' || !Number.isSafeInteger(body.version)) throw new AppError('bad_request');
    return app.editorProposals.decide(reqString(body, 'project', 120), body.task === undefined || body.task === '' ? '' : reqString(body, 'task', 120), reqString(body, 'id', 100), body.version, reqString(body, 'edit', 100), body.accept, body.text);
  });
  router.post('/api/editor/proposals/stop', async ({ body }) => ({ stopped: app.editorProposals.stop(reqString(body, 'project', 120), body.task === undefined || body.task === '' ? '' : reqString(body, 'task', 120)) }));
}
