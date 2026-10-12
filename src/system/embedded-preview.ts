import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { Duplex, Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';
import { findExecutable, minimalEnv, spawnCli, terminateTree } from '../cli/process.ts';
import { AppError } from '../shared/errors.ts';
import type { EmbeddedPreviewRequest, EmbeddedPreviewState } from '../shared/embedded-preview.ts';
import { executionArgs } from './execution-input.ts';

interface Run { view: EmbeddedPreviewState; child: ChildProcess; proxy: Server; origin: string; port: number; sockets: Set<Duplex>; stopping?: Promise<void>; }
export interface EmbeddedPreviewOptions {
  cwd(project: string, task: string): Promise<string>;
  assertTrusted(project: string): Promise<void>;
  beforeStart?(project: string, task: string): Promise<void>;
  /** Every origin the IDE can be opened on (the core answers on each loopback alias). */
  ideOrigins: string[];
  concurrent?: number;
}
async function listen(server: Server | NetServer): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  await promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new AppError('unavailable');
  return address.port;
}
async function close(server: Server | NetServer): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
}
/** Finished runs stay listable (exit code, last output) but only this many are kept. */
const FINISHED_RUNS = 20;
/** A redirect target on the dev server itself, as a path for the proxy origin; anything else (other host/port/scheme) is undefined. */
function sameServerPath(location: string | undefined, from: string, port: number): string | undefined {
  if (typeof location !== 'string' || !location || /[\0\r\n\\]/u.test(location)) return undefined;
  let url: URL;
  try { url = new URL(location, `http://127.0.0.1:${port}${from}`); } catch { return undefined; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port || 80) !== port || url.username || url.password) return undefined;
  // `//host/x` would be scheme-relative in the browser and leave the proxy origin.
  return url.pathname.startsWith('//') ? undefined : `${url.pathname}${url.search}${url.hash}`;
}
/** Every proxy has a distinct origin; no project response or credential enters the IDE origin. */
export class EmbeddedPreviewService {
  private readonly runs = new Map<string, Run>();
  private pending = 0;
  private readonly starting = new Map<string, { project: string; task: string }>();
  private readonly preparations = new Set<Promise<void>>();
  private readonly terminations = new Set<Promise<void>>();
  private disposed = false;
  private disposing?: Promise<void>;
  private gateway?: Server;
  private gatewayUrl = '';
  private initializing?: Promise<void>;
  private readonly options: EmbeddedPreviewOptions;
  constructor(options: EmbeddedPreviewOptions) { this.options = options; }
  gatewayOrigin(): string { return this.gatewayUrl; }
  async init(): Promise<void> {
    if (this.disposed) throw new AppError('unavailable');
    if (this.initializing) return this.initializing;
    this.initializing = this.openGateway();
    return this.initializing;
  }
  private async openGateway(): Promise<void> {
    const gateway = createServer((req, res) => {
      void this.wrapper(req, res).catch(() => { if (!res.headersSent) res.writeHead(403); res.end(); });
    });
    const port = await listen(gateway);
    this.gateway = gateway;
    this.gatewayUrl = `http://127.0.0.1:${port}`;
  }
  private async wrapper(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== new URL(this.gatewayUrl).host || !['GET', 'HEAD'].includes(req.method ?? '') || (req.headers.origin !== undefined && !['null', ...this.options.ideOrigins].includes(req.headers.origin))) { res.writeHead(403); res.end(); return; }
    const id = new URL(req.url ?? '/', this.gatewayUrl).pathname.slice(1);
    const run = this.runs.get(id);
    if (!run || !['starting', 'running'].includes(run.view.state)) { res.writeHead(404); res.end(); return; }
    await this.options.assertTrusted(run.view.project);
    // The trusted outer document enforces exact child navigation destinations, including in browsers.
    const body = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe title="${run.view.id}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${run.origin}/"></iframe></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-src ${run.origin}; frame-ancestors ${this.options.ideOrigins.join(' ')}; sandbox allow-scripts`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  origins(): string[] { return [this.gatewayUrl, ...[...this.runs.values()].filter(run => ['starting', 'running'].includes(run.view.state)).map(run => run.origin)].filter(Boolean); }
  isBusy(): boolean { return this.pending > 0 || [...this.runs.values()].some(run => ['starting', 'running'].includes(run.view.state)); }
  isRunning(project: string, task?: string): boolean {
    return [...this.starting.values()].some(scope => scope.project === project && (!task || scope.task === task)) || [...this.runs.values()].some(run => run.view.project === project && (!task || run.view.task === task) && ['starting', 'running'].includes(run.view.state));
  }
  list(project: string, task: string): EmbeddedPreviewState[] { return [...this.runs.values()].filter(run => run.view.project === project && run.view.task === task).map(run => ({ ...run.view })); }
  private owned(project: string, task: string, id: string): Run {
    const run = this.runs.get(id);
    if (!run || run.view.project !== project || run.view.task !== task) throw new AppError('not_found');
    return run;
  }
  status(project: string, task: string, id: string): EmbeddedPreviewState { return { ...this.owned(project, task, id).view }; }
  async start(project: string, task: string, input: EmbeddedPreviewRequest): Promise<EmbeddedPreviewState> {
    if (this.disposed) throw new AppError('unavailable');
    if (!input || typeof input.command !== 'string' || !input.command || input.command.length > 4096 || /[\0\r\n]/u.test(input.command)) throw new AppError('bad_request');
    const args = executionArgs(input.args);
    // The server must use our assigned port, not an arbitrary URL supplied by the caller.
    if (!args.some(arg => arg.includes('{port}'))) throw new AppError('bad_request');
    if (this.pending + [...this.runs.values()].filter(run => ['starting', 'running'].includes(run.view.state)).length >= (this.options.concurrent ?? 4)) throw new AppError('conflict');
    this.pending++;
    const pendingId = randomUUID();
    const preparation = Promise.withResolvers<void>();
    this.preparations.add(preparation.promise);
    let proxy: Server | undefined;
    let child: ChildProcess | undefined;
    try {
      await this.options.assertTrusted(project);
      await this.options.beforeStart?.(project, task);
      this.starting.set(pendingId, { project, task });
      await this.init();
      const cwd = await this.options.cwd(project, task);
      const env = minimalEnv([]);
      const command = await findExecutable(/[/\\]/u.test(input.command) ? path.resolve(cwd, input.command) : input.command, env, cwd);
      if (!command) throw new AppError('unavailable', 'cli_unavailable', { field: 'preview' });
      const reservation = createNetServer();
      const port = await listen(reservation);
      await close(reservation);
      const id = randomUUID();
      proxy = createServer();
      const proxyPort = await listen(proxy);
      const origin = `http://127.0.0.1:${proxyPort}`;
      const url = `${this.gatewayUrl}/${id}`;
      await this.options.assertTrusted(project);
      if (this.disposed) throw new AppError('unavailable');
      child = spawnCli(command, args.map(arg => arg.replaceAll('{port}', String(port)).replaceAll('{host}', '127.0.0.1')), { cwd, env: { ...env, HOST: '127.0.0.1', PORT: String(port) }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const run: Run = { view: { id, project, task, state: 'starting', url, targetUrl: `http://127.0.0.1:${port}/`, output: '', exitCode: null }, child, proxy, origin, port, sockets: new Set() };
      this.pruneFinished();
      this.runs.set(id, run);
      // One decoder per stream: a character split across two chunks would otherwise turn into replacement characters.
      const capture = (stream: Readable | null): void => {
        const decoder = new StringDecoder('utf8');
        stream?.on('data', (chunk: Buffer) => {
          const output = (run.view.output + decoder.write(chunk)).slice(-32768);
          run.view.output = /^[\uDC00-\uDFFF]/u.test(output) ? output.slice(1) : output;
        });
      };
      capture(child.stdout); capture(child.stderr);
      child.once('error', () => { run.view.state = 'failed'; proxy?.close(); });
      child.once('exit', code => { run.view.exitCode = code; if (run.view.state !== 'stopped') run.view.state = 'failed'; for (const socket of run.sockets) socket.destroy(); proxy?.closeAllConnections(); proxy?.close(); void this.terminate(run); });
      proxy.on('request', (req, res) => { void this.forward(run, req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); }); });
      proxy.on('upgrade', (req, socket, head) => {
        void this.options.assertTrusted(project).then(() => {
        if (!this.accept(run, req) || !['starting', 'running'].includes(run.view.state) || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof req.headers['sec-websocket-key'] !== 'string' || !/^[A-Za-z0-9+/]{22}==$/u.test(req.headers['sec-websocket-key'])) { socket.destroy(); return; }
        run.sockets.add(socket); socket.once('close', () => run.sockets.delete(socket));
        const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url, method: 'GET', headers: { host: `127.0.0.1:${port}`, origin: run.view.targetUrl.slice(0, -1), connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': req.headers['sec-websocket-key'] ?? '', 'sec-websocket-version': '13', ...(req.headers['sec-websocket-protocol'] ? { 'sec-websocket-protocol': req.headers['sec-websocket-protocol'] } : {}) } });
        upstream.setTimeout(10000, () => upstream.destroy());
        upstream.once('upgrade', (response, remote, remainder) => {
          if (response.statusCode !== 101) { remote.destroy(); socket.destroy(); return; }
          const accept = response.headers['sec-websocket-accept'];
          if (typeof accept !== 'string') { remote.destroy(); socket.destroy(); return; }
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n${typeof response.headers['sec-websocket-protocol'] === 'string' ? `Sec-WebSocket-Protocol: ${response.headers['sec-websocket-protocol']}\r\n` : ''}\r\n`);
          if (head.length) remote.write(head); if (remainder.length) socket.write(remainder);
          remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
          socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
          remote.pipe(socket); socket.pipe(remote);
        });
        upstream.once('response', response => { response.resume(); socket.destroy(); });
        upstream.once('error', () => socket.destroy()); upstream.end();
        }).catch(() => socket.destroy());
      });
      void this.ready(run);
      return { ...run.view };
    } catch (error) {
      if (proxy) await close(proxy); if (child) terminateTree(child, () => undefined);
      throw error;
    } finally { this.pending--; this.starting.delete(pendingId); this.preparations.delete(preparation.promise); preparation.resolve(); }
  }
  private accept(run: Run, req: IncomingMessage): boolean {
    const origin = run.origin;
    return req.headers.host === new URL(origin).host && (req.headers.origin === undefined || req.headers.origin === 'null' || req.headers.origin === origin || this.options.ideOrigins.includes(req.headers.origin)) && typeof req.url === 'string' && req.url.startsWith('/') && !req.url.startsWith('//') && !/[\0\r\n\\]/u.test(req.url);
  }
  /** Drops the oldest finished runs whose leader exited; group cleanup remains tracked independently. */
  private pruneFinished(): void {
    const finished = [...this.runs.entries()].filter(([, run]) => !['starting', 'running'].includes(run.view.state) && (run.child.exitCode !== null || run.child.signalCode !== null));
    for (const [id] of finished.slice(0, Math.max(0, finished.length - FINISHED_RUNS + 1))) this.runs.delete(id);
  }
  private async forward(run: Run, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.accept(run, req)) { res.writeHead(403); res.end(); return; }
    await this.options.assertTrusted(run.view.project);
    if (!['starting', 'running'].includes(run.view.state)) { res.writeHead(410); res.end(); return; }
    const origin = run.origin;
    const policy = `default-src ${origin}; script-src ${origin} 'unsafe-inline' 'unsafe-eval'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; connect-src ${origin} ${origin.replace('http:', 'ws:')}; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri ${origin}; form-action ${origin}; sandbox allow-scripts`;
    const headers = { 'Content-Security-Policy': policy, 'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: run.port, path: req.url, method: req.method, headers: { host: `127.0.0.1:${run.port}`, ...(typeof req.headers['content-type'] === 'string' ? { 'content-type': req.headers['content-type'] } : {}) } }, response => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        // Only a redirect that stays on the dev server survives, as a path on the proxy origin; any other target could
        // escape ownership, so it is never followed or exposed.
        const location = sameServerPath(response.headers.location, req.url!, run.port);
        response.resume();
        if (location) res.writeHead(status, { ...headers, Location: location }); else res.writeHead(502, headers);
        res.end(); return;
      }
      res.writeHead(response.statusCode ?? 502, { ...headers, ...(typeof response.headers['content-type'] === 'string' ? { 'Content-Type': response.headers['content-type'] } : {}), ...(typeof response.headers['content-encoding'] === 'string' ? { 'Content-Encoding': response.headers['content-encoding'] } : {}) });
      response.on('error', () => res.destroy()); response.pipe(res);
    });
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, headers); res.end(); });
    req.once('aborted', () => upstream.destroy()); res.once('close', () => upstream.destroy());
    let bytes = 0;
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { upstream.destroy(); if (!res.headersSent) res.writeHead(413, headers); res.end(); } });
    req.pipe(upstream);
  }
  private async ready(run: Run): Promise<void> {
    const deadline = Date.now() + 30000;
    while (run.view.state === 'starting' && Date.now() < deadline) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const probe = httpRequest({ hostname: '127.0.0.1', port: run.port, path: '/', method: 'GET' }, response => { response.resume(); resolve((response.statusCode ?? 500) < 500); });
      probe.setTimeout(500, () => probe.destroy()); probe.once('error', () => resolve(false)); probe.end();
      const ok = await promise;
      if (ok && run.view.state === 'starting') { run.view.state = 'running'; return; }
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 200);
      await delay.promise;
    }
    if (run.view.state === 'starting') { await this.stop(run.view.project, run.view.task, run.view.id); run.view.state = 'failed'; }
  }
  async stop(project: string, task: string, id: string): Promise<void> {
    const run = this.owned(project, task, id);
    run.view.state = 'stopped';
    for (const socket of run.sockets) socket.destroy();
    run.proxy.closeAllConnections(); run.proxy.close();
    return this.terminate(run);
  }
  private terminate(run: Run): Promise<void> {
    if (run.stopping) return run.stopping;
    const { promise, resolve } = Promise.withResolvers<void>();
    run.stopping = promise;
    this.terminations.add(promise);
    // The leader's exit is not completion: its group may still contain a server ignoring SIGTERM.
    terminateTree(run.child, () => { this.terminations.delete(promise); resolve(); });
    return promise;
  }
  async reload(project: string, task: string, id: string): Promise<EmbeddedPreviewState> {
    await this.options.assertTrusted(project);
    const view = this.status(project, task, id);
    if (view.state !== 'running') throw new AppError('conflict');
    return view;
  }
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      await Promise.all(this.preparations);
      await this.initializing;
      await Promise.all([...this.runs.values()].map(run => this.stop(run.view.project, run.view.task, run.view.id)));
      await Promise.all(this.terminations);
      this.gateway?.closeAllConnections();
      if (this.gateway) await close(this.gateway);
    })();
    return this.disposing;
  }
}
