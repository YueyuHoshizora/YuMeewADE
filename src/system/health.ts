import { promises as fs } from 'node:fs';
import { constants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { captureCommand, minimalEnv } from '../cli/process.ts';
import type { Config } from '../shared/config.ts';
import type { AiInfo, CareHealth, Settings } from '../shared/types.ts';

export interface HealthOptions {
  config: Config;
  catalog: { list(): Promise<AiInfo[]> };
  settings: { get(): Promise<Settings> };
  loginState: (ai: string) => Promise<'stored' | 'missing' | 'unknown'>;
  /** Desktop host supplies a verified code-signing state; absent means unknown, never signed. */
  buildTrust?: () => 'signed' | 'unsigned' | 'unknown';
}
export async function healthCheck(options: HealthOptions, network = false): Promise<CareHealth> {
  const [ais, settings] = await Promise.all([options.catalog.list(), options.settings.get()]);
  let writable = false;
  const probe = path.join(options.config.workspace.root, `.care-${randomUUID()}`);
  try {
    await fs.access(options.config.workspace.root, constants.W_OK);
    const handle = await fs.open(probe, 'wx', 0o600);
    try { await handle.writeFile('probe'); await handle.sync(); } finally { await handle.close(); }
    await fs.unlink(probe); writable = true;
  } catch { await fs.unlink(probe).catch(() => {}); }
  const result = await captureCommand({ command: 'git', args: ['--version'], env: minimalEnv([]), timeoutMs: 5000, maxOutputBytes: 1024 }).catch(() => null);
  const gitVersion = result?.ok ? /\b\d+\.\d+\.\d+(?:\.\d+)?\b/.exec(result.stdout)?.[0] ?? '' : '';
  const loopback = await loopbackCheck();
  let reachability: CareHealth['network'] = 'not-tested';
  if (network) {
    // Explicitly requested, fixed public HEAD endpoint; never CLI/model/quota requests.
    try { const response = await fetch('https://github.com', { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(5000) }); reachability = response.ok ? 'reachable' : 'unreachable'; }
    catch { reachability = 'unreachable'; }
  }
  return {
    checkedAt: new Date().toISOString(), node: process.versions.node, electron: process.versions['electron'] ?? null,
    git: { available: !!result?.ok, version: gitVersion }, writable, loopback,
    boundToLoopback: ['127.0.0.1', 'localhost', '::1'].includes(options.config.server.host), network: reachability,
    buildTrust: options.buildTrust?.() ?? 'unknown',
    clis: await Promise.all(ais.filter(ai => ['claude', 'codex', 'grok', 'gemini'].includes(ai.name)).map(async ai => ({
      name: ai.name, available: ai.available, version: safeVersion(ai.version), fullAccess: ai.fullAccess,
      configuredAccounts: settings.accounts[ai.name]?.length ?? 0, loginState: await options.loginState(ai.name),
    }))),
  };
}
export function safeVersion(value: string): string { return /^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(value) ? value : ''; }
async function loopbackCheck(): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const server = net.createServer(socket => socket.end()); let settled = false;
  const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); server.close(); resolve(ok); };
  const timer = setTimeout(() => finish(false), 3000); timer.unref();
  server.on('error', () => finish(false));
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); if (!address || typeof address === 'string') { finish(false); return; }
    const client = net.connect(address.port, '127.0.0.1'); client.once('connect', () => { client.destroy(); finish(true); }); client.once('error', () => finish(false));
  });
  return promise;
}
