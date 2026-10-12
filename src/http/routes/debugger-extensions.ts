import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { Router, reqString, optString } from '../router.ts';
import type { DapLaunch } from '../../shared/dap.ts';

export function registerDebuggerExtensionRoutes(router: Router, app: App): void {
  router.post('/api/debugger/dap/launch', async ({ body }) => {
    const project = reqString(body, 'project', 80); const task = reqString(body, 'task', 80);
    await app.trust.assertExecutable(project);
    return app.debugger.launchDap(project, task, body.launch as DapLaunch);
  });
  router.post('/api/debugger/source-breakpoint', async ({ body }) => {
    const project = reqString(body, 'project', 80); const task = reqString(body, 'task', 80);
    await app.trust.assertExecutable(project);
    if (!Number.isSafeInteger(body.revision)) throw new AppError('bad_request');
    return app.debugger.breakpoint(project, task, reqString(body, 'id', 80), reqString(body, 'path', 4096), body.line as number, optString(body, 'condition', 512), true, body.revision as number);
  });
  router.post('/api/debugger/source-breakpoint/delete', async ({ body }) => {
    const project = reqString(body, 'project', 80); const task = reqString(body, 'task', 80);
    await app.trust.assertExecutable(project);
    if (!Number.isSafeInteger(body.revision)) throw new AppError('bad_request');
    return app.debugger.removeBreakpoint(project, task, reqString(body, 'id', 80), reqString(body, 'breakpoint', 4096), body.revision as number);
  });
  router.post('/api/debugger/watch', async ({ body }) => {
    const project = reqString(body, 'project', 80); const task = reqString(body, 'task', 80);
    await app.trust.assertExecutable(project);
    return app.debugger.watch(project, task, reqString(body, 'id', 80), reqString(body, 'frame', 4096), reqString(body, 'expression', 256));
  });
}
