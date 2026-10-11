import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import type { DebugAction, ExecutionRequest, TerminalRequest } from '../../shared/types.ts';
import { executionArgs, executionEnv } from '../../system/execution-input.ts';
import { Router, reqString, optString } from '../router.ts';

export function registerExecutionRoutes(router: Router, app: App): void {
  router.post('/api/execution/start', async ({ body }) => {
    const request: ExecutionRequest = { command: reqString(body, 'command', 4096), args: executionArgs(body.args), env: executionEnv(body.env), ...(body.cwd !== undefined ? { cwd: reqString(body, 'cwd', 4096) } : {}), ...(body.kind !== undefined ? { kind: body.kind as NonNullable<ExecutionRequest['kind']> } : {}) };
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
  router.get('/api/execution/configs', async ({ query }) => app.execution.configurations(reqString(query, 'project', 80), reqString(query, 'task', 80)));
  router.post('/api/execution/config/save', async ({ body }) => app.execution.saveConfiguration(reqString(body, 'project', 80), reqString(body, 'task', 80), body.config));
  router.post('/api/execution/config/delete', async ({ body }) => app.execution.removeConfiguration(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'name', 80)));
  router.post('/api/execution/config/run', async ({ body }) => app.execution.startConfiguration(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'name', 80)));

  router.post('/api/terminal/start', async ({ body }) => {
    const request: TerminalRequest = { args: executionArgs(body.args), env: executionEnv(body.env), ...(body.command !== undefined ? { command: reqString(body, 'command', 4096) } : {}), ...(body.cwd !== undefined ? { cwd: reqString(body, 'cwd', 4096) } : {}), ...(body.cols !== undefined ? { cols: body.cols as number } : {}), ...(body.rows !== undefined ? { rows: body.rows as number } : {}) };
    return app.terminal.start(reqString(body, 'project', 80), reqString(body, 'task', 80), request);
  });
  // The capability is sent in POST bodies, never query strings, browser history or request URL logs.
  router.post('/api/terminal/output', async ({ body }) => app.terminal.output(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80), reqString(body, 'owner', 64), body.after === undefined ? 0 : body.after as number));
  router.post('/api/terminal/input', async ({ body }) => { app.terminal.input(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80), reqString(body, 'owner', 64), reqString(body, 'text', 16384)); return { ok: true }; });
  router.post('/api/terminal/resize', async ({ body }) => { app.terminal.resize(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80), reqString(body, 'owner', 64), body.cols as number, body.rows as number); return { ok: true }; });
  router.post('/api/terminal/stop', async ({ body }) => { await app.terminal.stop(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80), reqString(body, 'owner', 64)); return { ok: true }; });

  router.post('/api/debugger/attach', async ({ body }) => app.debugger.attach(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'run', 80)));
  router.get('/api/debugger/state', async ({ query }) => app.debugger.state(reqString(query, 'project', 80), reqString(query, 'task', 80), reqString(query, 'id', 80)));
  router.post('/api/debugger/action', async ({ body }) => app.debugger.action(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80), reqString(body, 'action', 20) as DebugAction));
  router.post('/api/debugger/variables', async ({ body }) => app.debugger.variables(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80), reqString(body, 'object', 4096)));
  router.post('/api/debugger/detach', async ({ body }) => { app.debugger.detach(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80)); return { ok: true }; });
}
