import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString } from '../router.ts';
import type { EditorAction, EditorBufferSnapshot, EditorChange, EditorMutation } from '../../shared/editor-workbench.ts';
import type { EditorSettingsPatch } from '../../shared/editor-preferences.ts';
export function registerEditorRoutes(router: Router, app: App): void {
  router.get('/api/editor/scope', async ({ query }) => app.editor.scope(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : '', app.ws.root));
  router.get('/api/editor/settings', async ({ query }) => app.editor.settings(reqString(query, 'project', 120)));
  router.get('/api/editor/preferences', async ({ query }) => app.editor.preferences(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : '', reqString(query, 'path', 1000)));
  router.get('/api/editor/history', async ({ query }) => app.editor.history(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : '', reqString(query, 'path', 1000)));
  router.post('/api/editor/history/restore', async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = body.task === undefined ? '' : reqString(body, 'task', 120);
    if (app.editorWriteBusy(project, task || undefined)) throw new AppError('conflict', 'editor_running');
    const result = await app.editor.restoreHistory(project, task, reqString(body, 'path', 1000), reqString(body, 'id', 100), reqString(body, 'revision', 100));
    if (task) app.verify.invalidate(project, task); app.changed(project, task || undefined); return result;
  });
  router.post('/api/editor/settings', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    await app.trust.assertExecutable(project);
    if (app.editorWriteBusy(project)) throw new AppError('conflict', 'editor_running');
    return app.editor.updateSettings(project, { revision: reqString(body, 'revision', 100), commands: body.commands, ...(body.format !== undefined ? { format: body.format } : {}) } as EditorSettingsPatch);
  });
  router.post('/api/editor/revisions', async ({ body }) => {
    if (!Array.isArray(body.documents) || body.documents.length > 50 || !body.documents.every(item => item && typeof item === 'object' && typeof item.path === 'string' && item.path.length <= 1000 && typeof item.revision === 'string' && item.revision.length <= 100)) throw new AppError('bad_request');
    return app.editor.revisions(reqString(body, 'project', 120), body.task === undefined ? '' : reqString(body, 'task', 120), body.documents as { path: string; revision: string }[]);
  });
  router.post('/api/editor/merge', async ({ body }) => {
    if (typeof body.base !== 'string' || typeof body.local !== 'string') throw new AppError('bad_request');
    return app.editor.merge(reqString(body, 'project', 120), body.task === undefined ? '' : reqString(body, 'task', 120), reqString(body, 'path', 1000), body.base, body.local, reqString(body, 'revision', 100));
  });
  router.get('/api/editor/file', async ({ query }) => app.editor.read(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : '', reqString(query, 'path', 1000)));
  router.get('/api/editor/image', async ({ query, res }) => {
    const image = await app.editor.image(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : '', reqString(query, 'path', 1000));
    res.writeHead(200, {
      'Content-Type': image.contentType, 'Content-Length': image.bytes.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'none'; sandbox",
    });
    res.end(image.bytes);
  });
  router.post('/api/editor/save', async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = body.task === undefined ? '' : reqString(body, 'task', 120);
    if (app.editorWriteBusy(project, task || undefined)) throw new AppError('conflict', 'editor_running');
    if (typeof body.text !== 'string') throw new AppError('bad_request');
    const result = await app.editor.save(project, task, reqString(body, 'path', 1000), body.text, reqString(body, 'revision', 100));
    if (task) app.verify.invalidate(project, task); app.changed(project, task || undefined);
    return result;
  });
  router.post('/api/editor/language', async ({ body }) => {
    const action = body.action;
    if (action === 'close') {
      await app.editor.close(reqString(body, 'project', 120), body.task === undefined ? '' : reqString(body, 'task', 120), reqString(body, 'path', 1000));
      return { ok: true };
    }
    if (typeof action !== 'string' || !['definition', 'references', 'diagnostics', 'completion', 'hover', 'rename', 'format', 'codeActions', 'documentSymbols', 'workspaceSymbols', 'signatureHelp', 'implementation', 'callHierarchy', 'inlayHints'].includes(action)) throw new AppError('bad_request');
    await app.trust.assertExecutable(reqString(body, 'project', 120));
    if (body.newName !== undefined && (typeof body.newName !== 'string' || body.newName.length > 200)) throw new AppError('bad_request');
    if (action === 'rename' && (typeof body.newName !== 'string' || !body.newName || body.newName.length > 200)) throw new AppError('bad_request');
    if (typeof body.text !== 'string' || !Number.isSafeInteger(body.line) || !Number.isSafeInteger(body.character) || (body.line as number) < 0 || (body.character as number) < 0) throw new AppError('bad_request');
    if (body.buffers !== undefined && (!Array.isArray(body.buffers) || body.buffers.length > 50 || !body.buffers.every(item => item && typeof item === 'object' && typeof item.path === 'string' && typeof item.revision === 'string' && typeof item.text === 'string'))) throw new AppError('bad_request');
    return app.editor.language(reqString(body, 'project', 120), body.task === undefined ? '' : reqString(body, 'task', 120), reqString(body, 'path', 1000), body.text, body.line as number, body.character as number, action as EditorAction, typeof body.newName === 'string' ? body.newName : undefined, body.buffers as EditorBufferSnapshot[] | undefined, body.revision === undefined ? undefined : reqString(body, 'revision', 100));
  });
  router.get('/api/editor/search', async ({ query }) => {
    for (const key of ['caseSensitive', 'wholeWord', 'regex']) if (query.has(key) && !['true', 'false'].includes(query.get(key)!)) throw new AppError('bad_request');
    const mode = query.get('mode') ?? 'content'; if (mode !== 'content' && mode !== 'files') throw new AppError('bad_request');
    return app.editor.search(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : '', reqString(query, 'q', 1000), { page: query.has('page') ? Number(query.get('page')) : 1, pageSize: query.has('pageSize') ? Number(query.get('pageSize')) : 50, caseSensitive: query.get('caseSensitive') === 'true', wholeWord: query.get('wholeWord') === 'true', regex: query.get('regex') === 'true', mode, ...(query.has('include') ? { include: reqString(query, 'include', 20000).split(',') } : {}), ...(query.has('exclude') ? { exclude: reqString(query, 'exclude', 20000).split(',') } : {}) });
  });
  router.get('/api/editor/problems', async ({ query }) => {
    const project = reqString(query, 'project', 120); await app.trust.assertExecutable(project);
    return app.editor.problems(project, query.has('task') ? reqString(query, 'task', 120) : '');
  });
  router.get('/api/editor/folder', async ({ query }) => app.editor.folderRevision(reqString(query, 'project', 120), query.has('task') ? reqString(query, 'task', 120) : '', reqString(query, 'path', 1000)));
  router.post('/api/editor/apply', async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = body.task === undefined ? '' : reqString(body, 'task', 120);
    if (app.editorWriteBusy(project, task || undefined)) throw new AppError('conflict', 'editor_running');
    if (!Array.isArray(body.changes) || body.changes.length > 50 || !body.changes.every(value => value && typeof value === 'object' && typeof value.path === 'string' && typeof value.revision === 'string' && typeof value.text === 'string')) throw new AppError('bad_request');
    const result = await app.editor.apply(project, task, body.changes as EditorChange[]);
    if (task) app.verify.invalidate(project, task); app.changed(project, task || undefined); return result;
  });
  router.post('/api/editor/mutate', async ({ body }) => {
    const project = reqString(body, 'project', 120); const task = body.task === undefined ? '' : reqString(body, 'task', 120);
    if (app.editorWriteBusy(project, task || undefined)) throw new AppError('conflict', 'editor_running');
    if (typeof body.action !== 'string' || !['createFile', 'createFolder', 'rename', 'delete'].includes(body.action)) throw new AppError('bad_request');
    const mutation: EditorMutation = { action: body.action as EditorMutation['action'], path: reqString(body, 'path', 1000) };
    if (body.destination !== undefined) mutation.destination = reqString(body, 'destination', 1000);
    if (body.revision !== undefined) mutation.revision = reqString(body, 'revision', 100);
    if (body.confirmation !== undefined) mutation.confirmation = reqString(body, 'confirmation', 1000);
    await app.editor.mutate(project, task, mutation); if (task) app.verify.invalidate(project, task); app.changed(project, task || undefined); return { ok: true };
  });
}
