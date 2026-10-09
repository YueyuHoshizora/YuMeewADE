// 桌面版啟動前的核心探測：純 node:http，不依賴 Electron，可單元測試。

import http from 'node:http';

/** 該 port 是否已有 YuMeewADE 核心在回應（可能是另一個網頁版實例）；別的程式佔用同 port 回 false。 */
export function probe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const req = http.get({ host, port, path: '/api/ping', headers: { Host: `${host}:${port}` }, timeout: timeoutMs }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      if (body.length < 4096) body += c;
    });
    res.on('end', () => {
      try {
        resolve(res.statusCode === 200 && (JSON.parse(body) as { app?: unknown }).app === 'yumeewade');
      } catch {
        resolve(false);
      }
    });
    res.on('error', () => resolve(false));
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => {
    req.destroy();
    resolve(false);
  });
  return promise;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** 每 intervalMs 探一次直到 ready 或逾時；alive() 回 false 代表核心已死，立刻放棄。 */
export async function waitForCore(host: string, port: number, opts: { timeoutMs: number; intervalMs: number; alive: () => boolean }): Promise<'ready' | 'dead' | 'timeout'> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(host, port)) return 'ready';
    if (!opts.alive()) return 'dead';
    await delay(opts.intervalMs);
  }
  return 'timeout';
}
