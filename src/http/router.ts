// 路由與請求閘門：Host／Origin 檢查、請求體上限、JSON 解析、對外 generic 錯誤。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { validEffort, validModelName } from '../shared/ai-pick.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** postRaw 路由的原始請求體；其他路由為空 Buffer。 */
  raw: Buffer;
  /** postStream 路由的有上限串流；不把大型加密備份載入記憶體。 */
  stream?: Readable;
  ip: string;
}

/** 回傳值會以 JSON 送出；回 undefined 代表 handler 自己寫了回應（SSE、二進位）。 */
export type Handler = (ctx: Ctx) => Promise<unknown | undefined>;

export interface RouterOptions {
  host: string;
  port: number;
  bodyBytes: number;
}

function prepareJson(res: ServerResponse, status: number, data: unknown): string {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return payload;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.end(prepareJson(res, status, data));
}

/** Keep the response readable while an ordinary uploader is still writing, without retaining its rejected body. */
function sendTooLarge(req: IncomingMessage, res: ServerResponse, err: AppError): void {
  res.setHeader('Connection', 'close');
  res.write(prepareJson(res, err.status, err.toJSON()));
  if (req.destroyed || req.readableEnded) {
    res.end();
    return;
  }
  // Ending a Connection: close response also destroys Node's socket. Defer that
  // until the unread body drains, but bound both the bytes discarded and time.
  const socket = req.socket;
  let discarded = 0;
  const finish = () => {
    clearTimeout(timer);
    req.off('data', discard);
    req.off('end', finish);
    req.off('error', finish);
    socket.off('close', finish);
    req.pause();
    res.end();
  };
  const discard = (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded >= 32 * 1024 * 1024) finish();
  };
  const timer = setTimeout(finish, 2_000);
  timer.unref();
  req.on('data', discard);
  req.once('end', finish);
  req.once('error', finish);
  socket.once('close', finish);
  req.resume();
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    if (err.status === 500) log.error('請求失敗', err);
    sendJson(res, err.status, err.toJSON());
    return;
  }
  log.error('未預期的錯誤', err);
  sendJson(res, 500, { error: 'internal', message: '內部錯誤' });
}

/** Every authority the core answers on; the UI may be opened through any of them. */
export function loopbackAuthorities(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

/** Host 必須是 127.0.0.1:{port}／localhost:{port}；非 GET 若帶 Origin 必須同源。 */
export function checkOrigin(req: IncomingMessage, opts: RouterOptions): void {
  const allowedHosts = loopbackAuthorities(opts.port);
  const host = req.headers.host ?? '';
  if (!allowedHosts.includes(host)) throw new AppError('forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.some((h) => origin === `http://${h}`)) throw new AppError('forbidden');
  }
}

/** API calls additionally refuse requests a page on another site made (see below); the UI itself may be navigated to from anywhere. */
function checkApiSource(req: IncomingMessage): void {
  // A GET carries no Origin, so a page elsewhere (another site, or another loopback port such as a dev server or the
  // embedded preview) could still trigger API reads with side effects — CLI command discovery, GitHub queries, Git
  // status. Browsers mark where each request comes from; only the UI itself (same-origin) or a typed URL may call.
  // This runs only for requests already routed as API calls: testing the raw request target here would let
  // `//other.host/api/…` (which routes to /api/…) slip past.
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') throw new AppError('forbidden');
}

export async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new AppError('too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new AppError('too_large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size);
}

function boundedBody(req: IncomingMessage, limit: number): Readable {
  return Readable.from((async function* () {
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > limit) throw new AppError('too_large');
      yield bytes;
    }
  })());
}

export async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req, limit);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError('bad_request', 'bad_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('bad_request', 'body_not_object');
  return parsed as Record<string, unknown>;
}

const EMPTY: Buffer = Buffer.alloc(0);

export class Router {
  private readonly routes: Record<string, { handler: Handler; rawLimit?: number; streamLimit?: number }> = {};
  private readonly opts: RouterOptions;
  private mutationGuard?: (path: string, work: () => Promise<unknown>) => Promise<unknown>;
  private requestGuard?: (path: string, ctx: Ctx) => Promise<void>;

  constructor(opts: RouterOptions) {
    this.opts = opts;
  }

  setMutationGuard(guard: (path: string, work: () => Promise<unknown>) => Promise<unknown>): void {
    this.mutationGuard = guard;
  }

  setRequestGuard(guard: (path: string, ctx: Ctx) => Promise<void>): void {
    this.requestGuard = guard;
  }

  get(path: string, handler: Handler): void {
    this.routes[`GET ${path}`] = { handler };
  }

  post(path: string, handler: Handler): void {
    this.routes[`POST ${path}`] = { handler };
  }

  /** 請求體不解析 JSON，原樣放在 ctx.raw（上限 limit 位元組）。 */
  postRaw(path: string, limit: number, handler: Handler): void {
    this.routes[`POST ${path}`] = { handler, rawLimit: limit };
  }

  /** 大型二進位輸入串流仍受來源檢查、寫入閘門與位元組上限保護。 */
  postStream(path: string, limit: number, handler: Handler): void {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid stream limit');
    this.routes[`POST ${path}`] = { handler, streamLimit: limit };
  }

  /** 回 true 代表已處理（含錯誤回應）；false 代表不是 API 路徑。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    // Every request, static files included, must name a loopback Host (DNS rebinding) and a same-origin Origin when it writes.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
      checkOrigin(req, this.opts);
    } catch (err) {
      sendError(res, err instanceof AppError ? err : new AppError('bad_request'));
      return true;
    }
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      checkApiSource(req);
      const route = this.routes[`${req.method} ${url.pathname}`];
      if (!route) throw new AppError('not_found');
      let body: Record<string, unknown> = {};
      let raw = EMPTY;
      let stream: Readable | undefined;
      if (req.method === 'POST') {
        if (route.streamLimit !== undefined) {
          if (Number(req.headers['content-length'] ?? 0) > route.streamLimit) throw new AppError('too_large');
          stream = boundedBody(req, route.streamLimit);
        } else if (route.rawLimit !== undefined) raw = await readRawBody(req, route.rawLimit);
        else body = await readJsonBody(req, this.opts.bodyBytes);
      }
      const ctx: Ctx = { req, res, query: url.searchParams, body, raw, ...(stream ? { stream } : {}), ip: req.socket.remoteAddress ?? '' };
      const invoke = async () => { await this.requestGuard?.(url.pathname, ctx); return route.handler(ctx); };
      const result = req.method === 'POST' && this.mutationGuard ? await this.mutationGuard(url.pathname, invoke) : await invoke();
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof AppError && err.code === 'too_large' && !res.headersSent) {
        sendTooLarge(req, res, err);
        return true;
      }
      if (!res.headersSent) sendError(res, err);
      else {
        log.error('回應已送出後發生錯誤', err);
        res.end();
      }
    }
    return true;
  }
}

// ---- 輸入驗證小工具 ----

export function reqString(src: Record<string, unknown> | URLSearchParams, key: string, max: number): string {
  const v = src instanceof URLSearchParams ? src.get(key) : src[key];
  if (typeof v !== 'string' || v.length === 0) throw new AppError('bad_request', 'field_required', { field: key });
  if (v.length > max) throw new AppError('bad_request', 'field_too_long', { field: key });
  return v;
}

export function optString(src: Record<string, unknown> | URLSearchParams, key: string, max: number): string | undefined {
  const v = src instanceof URLSearchParams ? src.get(key) : src[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppError('bad_request', 'field_type', { field: key });
  if (v.length > max) throw new AppError('bad_request', 'field_too_long', { field: key });
  return v;
}

/** Optional model id; '' is kept as an explicit "provider default". */
export function optModel(src: Record<string, unknown>, key = 'model'): string | undefined {
  const v = src[key];
  if (v === undefined || v === null) return undefined;
  if (!validModelName(v)) throw new AppError('bad_request', 'field_type', { field: key });
  return v;
}

/** Optional reasoning effort; '' is kept as an explicit "provider default". */
export function optEffort(src: Record<string, unknown>, key = 'effort'): string | undefined {
  const v = src[key];
  if (v === undefined || v === null) return undefined;
  if (!validEffort(v)) throw new AppError('bad_request', 'invalid_effort');
  return v;
}
