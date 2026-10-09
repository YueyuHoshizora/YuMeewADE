import type { App } from '../../server/app.ts';
import { AppError } from '../../shared/errors.ts';
import { openPath } from '../../system/open.ts';
import { Router, reqString } from '../router.ts';

export function registerSystemRoutes(router: Router, _app: App): void {
  router.post('/api/open', async ({ body }) => {
    if (body.reveal !== undefined && typeof body.reveal !== 'boolean') throw new AppError('bad_request');
    await openPath(reqString(body, 'path', 4096), body.reveal as boolean | undefined);
    return { ok: true };
  });
}
