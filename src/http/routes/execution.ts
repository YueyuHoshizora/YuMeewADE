import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import type { ExecutionRequest } from '../../shared/types.ts';
import { Router, reqString, optString } from '../router.ts';

export function registerExecutionRoutes(router: Router, app: App): void {
  router.post('/api/execution/start', async ({ body }) => {
    if (body.args !== undefined && (!Array.isArray(body.args) || body.args.some(a => typeof a !== 'string'))) throw new AppError('bad_request');
    const request: ExecutionRequest = { command: reqString(body, 'command', 4096), ...(body.args !== undefined ? { args: body.args as string[] } : {}), ...(body.kind !== undefined ? { kind: body.kind as NonNullable<ExecutionRequest['kind']> } : {}) };
    return app.execution.start(reqString(body, 'project', 80), reqString(body, 'task', 80), request);
  });
  router.get('/api/execution/list', async ({ query }) => app.execution.list(reqString(query, 'project', 80), reqString(query, 'task', 80)));
  router.get('/api/execution/output', async ({ query }) => app.execution.output(reqString(query, 'project', 80), reqString(query, 'task', 80), reqString(query, 'id', 80), Number(query.get('after') ?? 0)));
  router.post('/api/execution/stop', async ({ body }) => { await app.execution.stop(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80)); return { ok: true }; });
  router.post('/api/execution/preview', async ({ body }) => { await app.integrations.preview(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'url', 4096)); return { ok: true }; });
  router.post('/api/execution/ide', async ({ body }) => { await app.integrations.ide(reqString(body, 'project', 80), reqString(body, 'task', 80)); return { ok: true }; });
  router.post('/api/execution/terminal', async ({ body }) => { await app.integrations.terminal(reqString(body, 'project', 80), reqString(body, 'task', 80), optString(body, 'command', 8192)); return { ok: true }; });
  router.post('/api/execution/debug', async ({ body }) => {
    if (body.target !== undefined && body.target !== 'browser' && body.target !== 'ide') throw new AppError('bad_request');
    await app.integrations.debug(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'url', 4096), body.target as 'browser' | 'ide' | undefined);
    return { ok: true };
  });
}
