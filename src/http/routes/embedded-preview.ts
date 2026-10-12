import type { EmbeddedPreviewService } from '../../system/embedded-preview.ts';
import { executionArgs } from '../../system/execution-input.ts';
import { Router, reqString } from '../router.ts';

export function registerEmbeddedPreviewRoutes(router: Router, preview: EmbeddedPreviewService): void {
  router.get('/api/embedded-preview/origins', async () => ({ origins: preview.origins() }));
  router.post('/api/embedded-preview/start', async ({ body }) => preview.start(reqString(body, 'project', 80), reqString(body, 'task', 80), { command: reqString(body, 'command', 4096), args: executionArgs(body.args) }));
  router.get('/api/embedded-preview/list', async ({ query }) => preview.list(reqString(query, 'project', 80), reqString(query, 'task', 80)));
  router.get('/api/embedded-preview/status', async ({ query }) => preview.status(reqString(query, 'project', 80), reqString(query, 'task', 80), reqString(query, 'id', 80)));
  router.post('/api/embedded-preview/reload', async ({ body }) => preview.reload(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80)));
  router.post('/api/embedded-preview/stop', async ({ body }) => { await preview.stop(reqString(body, 'project', 80), reqString(body, 'task', 80), reqString(body, 'id', 80)); return { ok: true }; });
}
