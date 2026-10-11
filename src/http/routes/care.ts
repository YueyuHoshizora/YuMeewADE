import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { reqString, type Router } from '../router.ts';

export function registerCareRoutes(router: Router, app: App): void {
  router.get('/api/care/health', async () => app.mutations.run(() => app.care.health()));
  router.post('/api/care/health', async ({ body }) => {
    if (typeof body.network !== 'boolean') throw new AppError('bad_request');
    return app.care.health(body.network);
  });
  router.get('/api/care/backups', async () => ({ backups: await app.care.backups.list() }));
  router.post('/api/care/backup', async ({ body }) => {
    if (typeof body.includeExternal !== 'boolean') throw new AppError('bad_request');
    return app.care.backup(body.includeExternal);
  });
  router.post('/api/care/restore', async ({ body }) => app.care.restore(reqString(body, 'id', 36), reqString(body, 'destination', 4096)));
  router.get('/api/care/diagnostics', async ({ res }) => {
    const bytes = await app.mutations.run(() => app.care.diagnostics());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="yumeewade-diagnostics.json"', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  });
}
