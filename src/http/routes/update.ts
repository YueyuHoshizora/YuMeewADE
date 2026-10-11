import { AppError } from '../../shared/errors.ts';
import type { UpdateDownloads } from '../../system/update-download.ts';
import { Router, reqString } from '../router.ts';

export function registerUpdateRoutes(router: Router, downloads: UpdateDownloads): void {
  router.post('/api/update/download', async ({ body }) => {
    if (body.confirmed !== true) throw new AppError('bad_request');
    return downloads.download(reqString(body, 'version', 40), reqString(body, 'name', 180));
  });
  router.post('/api/update/action', async ({ body }) => {
    if (body.confirmed !== true || typeof body.launch !== 'boolean') throw new AppError('bad_request');
    await downloads.action(reqString(body, 'token', 40), body.launch);
    return { ok: true };
  });
}
