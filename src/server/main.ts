// 核心進入點：讀 config → 建工作區 → 啟動 HTTP。網頁版與桌面版都從這裡起核心。

import path from 'node:path';
import { createHttpServer, listen } from '../http/server.ts';
import { ConfigError, loadConfig } from '../shared/config.ts';
import { log } from '../shared/log.ts';
import { App } from './app.ts';

async function main(): Promise<void> {
  const config = await loadConfig();
  const app = new App(config);
  log.setFile(path.join(app.ws.root, '.yumeewade', 'yumeewade.log'));
  await app.init();
  const server = createHttpServer(app);
  await listen(server, config.server.host, config.server.port);
  const url = `http://${config.server.host}:${config.server.port}`;
  log.info('YuMeewADE 已啟動', { url, root: app.ws.root, config: config.source ?? '(預設)', version: app.version });
  process.stdout.write(`YuMeewADE ${app.version} ${url}\n`);
  const shutdown = () => {
    log.info('收到結束訊號，關閉中');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  if (err instanceof ConfigError) process.stderr.write(`設定錯誤：${err.message}\n`);
  else if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') process.stderr.write('port 已被占用（是否已有另一個 YuMeewADE 在跑？）\n');
  else log.error('啟動失敗', err);
  await log.flush();
  process.exit(1);
});
