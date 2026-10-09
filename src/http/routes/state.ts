import type { App } from '../../server/app.ts';
import { GLOBAL } from '../sse.ts';
import { Router } from '../router.ts';
import { AppError } from '../../shared/errors.ts';

export function registerStateRoutes(router: Router, app: App): void {
  // 桌面版啟動探測用：不碰檔案系統，只確認是 YuMeewADE 核心在回應
  router.get('/api/ping', async () => ({ ok: true, app: 'yumeewade', version: app.version }));
  router.get('/api/state', () => app.state());
  router.get('/api/events', async ({ req, res }) => {
    app.sse.open(req, res, GLOBAL, { event: 'ready', data: { version: app.version } });
  });
  router.get('/api/log', async ({ query }) => {
    const raw = query.get('n');
    const n = raw === null ? 50 : Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new AppError('bad_request');
    return app.oplog.recent(Math.min(n, 200));
  });
}
