import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { reqString, type Router } from '../router.ts';
import { createReadStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { PORTABLE_LIMIT } from '../../ledger/portable-backup.ts';
import type { CareSchedule } from '../../shared/types.ts';

function passwordHeader(headers: { [key: string]: string | string[] | undefined }): string {
  const value = headers['x-backup-password'];
  if (typeof value !== 'string' || value.length > 1400 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new AppError('bad_request');
  const password = Buffer.from(value, 'base64').toString('utf8');
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new AppError('bad_request');
  return password;
}

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
  router.get('/api/care/capacity', async () => app.care.backups.capacity());
  router.post('/api/care/delete', async ({ body }) => {
    await app.mutations.run(() => app.care.backups.delete(reqString(body, 'id', 36), reqString(body, 'confirmation', 36))); return { ok: true };
  });
  router.get('/api/care/schedule', async () => app.care.scheduleStatus());
  router.post('/api/care/schedule', async ({ body }) => {
    if (typeof body.enabled !== 'boolean' || typeof body.includeExternal !== 'boolean' || typeof body.intervalHours !== 'number' || typeof body.retention !== 'number') throw new AppError('bad_request');
    const schedule: CareSchedule = { enabled: body.enabled, includeExternal: body.includeExternal, intervalHours: body.intervalHours, retention: body.retention };
    return app.care.setSchedule(schedule);
  });
  router.post('/api/care/export', async ({ body, req, res }) => {
    const password = passwordHeader(req.headers);
    await app.care.export(reqString(body, 'id', 36), password, async file => {
      const size = (await fs.stat(file)).size;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=\"backup.ymae\"', 'Content-Length': size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      await pipeline(createReadStream(file), res);
    });
  });
  router.postStream('/api/care/import', PORTABLE_LIMIT, async ({ req, stream, query }) => {
    if (!stream || req.headers['content-type'] !== 'application/octet-stream') throw new AppError('bad_request');
    const password = passwordHeader(req.headers); const destination = reqString(query, 'destination', 4096);
    return app.care.import(stream, password, destination);
  });
  router.get('/api/care/diagnostics', async ({ res }) => {
    const bytes = await app.mutations.run(() => app.care.diagnostics());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="yumeewade-diagnostics.json"', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  });
}
