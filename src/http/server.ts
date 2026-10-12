// HTTP 伺服器：API 路由＋靜態前端。只綁 loopback（config 已驗證）。

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../server/app.ts';
import { log } from '../shared/log.ts';
import { Router } from './router.ts';
import { registerRoutes } from './routes/index.ts';
import { serveStatic } from './static.ts';

export const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

export interface HttpCore {
  server: http.Server;
  /** 換上另一個 App 的路由；之後的請求都交給它，已在處理中的請求照舊完成。 */
  mount(app: App): void;
}

function routerFor(app: App): Router {
  const { host, port } = app.config.server;
  const router = new Router({ host, port, bodyBytes: app.config.limits.bodyBytes });
  registerRoutes(router, app);
  return router;
}

export function createHttpServer(app: App): HttpCore {
  let router = routerFor(app);
  let mounted = app;
  const server = http.createServer((req, res) => {
    // Any site can point a frame at the loopback port; the app's own controls must never be clickable inside someone else's page.
    res.setHeader('X-Frame-Options', 'DENY');
    router
      .handle(req, res)
      .then((handled) => (handled ? undefined : serveStatic(UI_DIR, req, res, mounted.embeddedPreview.gatewayOrigin())))
      .catch((err) => {
        log.error('請求處理失敗', err);
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  server.keepAliveTimeout = 65_000;
  return { server, mount: next => { router = routerFor(next); mounted = next; } };
}

export function listen(server: http.Server, host: string, port: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    resolve();
  });
  return promise;
}
