import type { App } from '../../server/app.ts';
import type { ProposalFileInput, ProposalSnapshot } from '../../shared/editor-proposals.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request');
  return value as Record<string, unknown>;
}
function snapshot(value: unknown): ProposalSnapshot {
  const row = object(value);
  if (typeof row.text !== 'string' || row.text.length > 262_144) throw new AppError('bad_request');
  return { path: reqString(row, 'path', 1000), revision: reqString(row, 'revision', 100), text: row.text };
}
export function registerEditorProposalRoutes(router: Router, app: App): void {
  router.get('/api/editor/proposals', async ({ query }) => ({ proposals: await app.editorProposals.history(reqString(query, 'project', 120), query.get('task') ?? '') }));
  router.post('/api/editor/proposals/generate', async ({ body, ip }) => {
    if (!app.sendLimiter.take(ip)) throw new AppError('too_many_requests');
    const project = reqString(body, 'project', 120); const task = body.task === undefined || body.task === '' ? '' : reqString(body, 'task', 120);
    await app.trust.assertExecutable(project);
    if (app.taskBusy(project, task || undefined)) throw new AppError('conflict', 'editor_running');
    if (!Array.isArray(body.files) || !body.files.length || body.files.length > 16) throw new AppError('bad_request');
    const files: ProposalFileInput[] = body.files.map(value => {
      const row = object(value); const selection = object(row.selection);
      if (typeof selection.from !== 'number' || typeof selection.to !== 'number') throw new AppError('bad_request');
      return { ...snapshot(value), selection: { from: selection.from, to: selection.to } };
    });
    return app.editorProposals.generate(project, task, { files, instruction: reqString(body, 'instruction', 100_000), ai: reqString(body, 'ai', 20), ...(body.model === undefined ? {} : { model: reqString(body, 'model', 200) }), ...(body.effort === undefined ? {} : { effort: reqString(body, 'effort', 100) }) });
  });
  router.post('/api/editor/proposals/decide', async ({ body }) => {
    if (typeof body.accept !== 'boolean' || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || !Array.isArray(body.snapshots) || !body.snapshots.length || body.snapshots.length > 16) throw new AppError('bad_request');
    const target = body.target === undefined ? undefined : object(body.target);
    return app.editorProposals.decide(reqString(body, 'project', 120), body.task === undefined || body.task === '' ? '' : reqString(body, 'task', 120), reqString(body, 'id', 100), { version: body.version, accept: body.accept, snapshots: body.snapshots.map(snapshot), ...(target ? { target: { path: reqString(target, 'path', 1000), edit: reqString(target, 'edit', 100) } } : {}) });
  });
  router.post('/api/editor/proposals/recover', async ({ body }) => {
    if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || !Array.isArray(body.snapshots) || !body.snapshots.length || body.snapshots.length > 16) throw new AppError('bad_request');
    return app.editorProposals.recover(reqString(body, 'project', 120), body.task === undefined || body.task === '' ? '' : reqString(body, 'task', 120), reqString(body, 'id', 100), body.version, body.snapshots.map(snapshot));
  });
  router.post('/api/editor/proposals/stop', async ({ body }) => ({ stopped: app.editorProposals.stop(reqString(body, 'project', 120), body.task === undefined || body.task === '' ? '' : reqString(body, 'task', 120)) }));
}
