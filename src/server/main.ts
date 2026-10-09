// 核心進入點：讀 config → 建工作區 → 啟動 HTTP。網頁版與桌面版都從這裡起核心。

import { listen } from '../http/server.ts';
import { ConfigError, hostAuthority, loadConfig } from '../shared/config.ts';
import { log } from '../shared/log.ts';
import { CoreHost } from './host.ts';

async function main(): Promise<void> {
  const config = await loadConfig();
  const host = new CoreHost(config, { logs: true });
  await host.init();
  const { server } = host;
  await listen(server, config.server.host, config.server.port);
  const url = `http://${hostAuthority(config.server.host, config.server.port)}`;
  log.info('YuMeewADE 已啟動', { url, root: host.app.ws.root, config: config.source ?? '(預設)', version: host.app.version });
  process.stdout.write(`YuMeewADE ${host.app.version} ${url}\n`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log.info('收到結束訊號，停止 AI 並保存紀錄');
    const deadline = setTimeout(() => process.exit(0), 6000);
    void (async () => {
      try {
        await host.shutdown();
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        await log.flush();
      } catch (err) { log.error('核心關閉失敗', err); }
      finally { clearTimeout(deadline); process.exit(0); }
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const parentPort = (process as NodeJS.Process & { parentPort?: { on(event: 'message', listener: (message: { data: unknown }) => void): void } }).parentPort;
  parentPort?.on('message', message => { if (message.data === 'shutdown') shutdown(); });
}

main().catch(async (err) => {
  if (err instanceof ConfigError) process.stderr.write(`設定錯誤：${err.message}\n`);
  else if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') process.stderr.write('port 已被占用（是否已有另一個 YuMeewADE 在跑？）\n');
  else log.error('啟動失敗', err);
  await log.flush();
  process.exit(1);
});
