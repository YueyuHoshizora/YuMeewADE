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

export function createHttpServer(app: App): http.Server {
  const { host, port } = app.config.server;
  const router = new Router({ host, port, bodyBytes: app.config.limits.bodyBytes });
  registerRoutes(router, app);
  const server = http.createServer((req, res) => {
    router
      .handle(req, res)
      .then((handled) => (handled ? undefined : serveStatic(UI_DIR, req, res)))
      .catch((err) => {
        log.error('請求處理失敗', err);
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  server.keepAliveTimeout = 65_000;
  return server;
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
