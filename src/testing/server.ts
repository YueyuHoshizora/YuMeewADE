// 測試用：臨時工作區＋真實 HTTP 伺服器（隨機 port）。

import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { listen } from '../http/server.ts';
import { MockCliProvider } from '../cli/mock.ts';
import type { App, AppOptions } from '../server/app.ts';
import { CoreHost } from '../server/host.ts';
import { parseConfig } from '../shared/config.ts';

async function freePort(): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const port = (srv.address() as net.AddressInfo).port;
    srv.close(() => resolve(port));
  });
  return promise;
}

export interface TestServer {
  /** 目前掛載的 App（切換工作區後會換成新的）。 */
  readonly app: App;
  /** 測試用設定檔；切換工作區會寫回這裡，不碰使用者的 ~/.yumeewade。 */
  configFile: string;
  base: string;
  port: number;
  dir: string;
  /** fetch 包裝：自動帶 JSON 與正確 Host。 */
  api(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: unknown }>;
  close(): Promise<void>;
}

export async function startTestServer(configYaml = '', options: AppOptions = {}): Promise<TestServer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yumeewade-http-'));
  const port = await freePort();
  const configFile = path.join(dir, 'config.yaml');
  const text = `server:\n  port: ${port}\nworkspace:\n  root: ${JSON.stringify(path.join(dir, 'root'))}\n${configYaml}`;
  await fs.writeFile(configFile, text);
  const host = new CoreHost(parseConfig(text, configFile), { app: { ...options, providers: options.providers ?? { mock: new MockCliProvider(5) }, home: options.home ?? path.join(dir, 'home') } });
  await host.init();
  const { server } = host;
  await listen(server, '127.0.0.1', port);
  const base = `http://127.0.0.1:${port}`;
  return {
    get app() { return host.app; },
    configFile,
    base,
    port,
    dir,
    async api(method, p, body, headers = {}) {
      const res = await fetch(base + p, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, json };
    },
    async close() {
      await host.app.runner.whenIdle();
      host.close();
      server.closeAllConnections();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
