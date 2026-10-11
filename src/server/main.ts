// 核心進入點：讀 config → 建工作區 → 啟動 HTTP。網頁版與桌面版都從這裡起核心。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CredentialAccounts } from '../cli/accounts.ts';
import { CredentialVault } from '../credentials/vault.ts';
import { createSecretProtector, getSecretDataDirectory } from '../shared/secret-protection.ts';
import { listen } from '../http/server.ts';
import { ConfigError, hostAuthority, loadConfig } from '../shared/config.ts';
import { log } from '../shared/log.ts';
import { CoreHost } from './host.ts';

async function main(): Promise<void> {
  const config = await loadConfig();
  const protector = await createSecretProtector();
  let vault: CredentialVault | undefined;
  let accounts: CredentialAccounts | undefined;
  let host: CoreHost | undefined;
  const closeCredentials = async () => {
    try { await accounts?.close(); }
    finally {
      try { vault?.close(); }
      finally { await protector.close(); }
    }
  };
  try {
    const home = getSecretDataDirectory(protector);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const directory = path.join(await fs.realpath(home), 'credentials');
    vault = await CredentialVault.open(directory, protector);
    accounts = new CredentialAccounts(vault, directory, config.cli.envPassthrough);
    host = new CoreHost(config, { logs: true, app: { accounts } });
    await host.init();
    await listen(host.server, config.server.host, config.server.port);
  } catch (err) {
    try { await host?.shutdown(); }
    finally { await closeCredentials(); }
    throw err;
  }
  const runningHost = host;
  const { server } = runningHost;
  const url = `http://${hostAuthority(config.server.host, config.server.port)}`;
  log.info('YuMeewADE 已啟動', { url, root: runningHost.app.ws.root, config: config.source ?? '(預設)', version: runningHost.app.version });
  process.stdout.write(`YuMeewADE ${runningHost.app.version} ${url}\n`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log.info('收到結束訊號，停止 AI 並保存紀錄');
    const deadline = setTimeout(() => {
      log.warn('核心未在關閉期限內完成保存，強制結束');
      process.exit(1);
    }, 6000);
    void (async () => {
      let exitCode = 0;
      try {
        try { await runningHost.shutdown(); }
        finally { await closeCredentials(); }
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        await log.flush();
      } catch (err) { exitCode = 1; log.error('核心關閉失敗', err); }
      finally { clearTimeout(deadline); process.exit(exitCode); }
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
