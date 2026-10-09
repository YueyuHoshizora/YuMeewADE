// 路由與請求閘門：Host／Origin 檢查、請求體上限、JSON 解析、對外 generic 錯誤。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  body: Record<string, unknown>;
  ip: string;
}

export type Handler = (ctx: Ctx) => Promise<unknown | undefined>;

export interface RouterOptions {
  host: string;
  port: number;
  bodyBytes: number;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    if (err.status === 500) log.error('請求失敗', err);
    sendJson(res, err.status, { error: err.code, message: err.publicMessage });
    return;
  }
  log.error('未預期的錯誤', err);
  sendJson(res, 500, { error: 'internal', message: '內部錯誤' });
}

/** Host 必須是 127.0.0.1:{port}／localhost:{port}；非 GET 若帶 Origin 必須同源。 */
export function checkOrigin(req: IncomingMessage, opts: RouterOptions): void {
  const allowedHosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`];
  const host = req.headers.host ?? '';
  if (!allowedHosts.includes(host)) throw new AppError('forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.some((h) => origin === `http://${h}`)) throw new AppError('forbidden');
  }
}

export async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
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
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('bad_request', 'JSON 格式錯誤');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('bad_request', '請求體必須是 JSON 物件');
  return parsed as Record<string, unknown>;
}

export class Router {
  private readonly routes: Record<string, Handler> = {};
  private readonly opts: RouterOptions;

  constructor(opts: RouterOptions) {
    this.opts = opts;
  }

  get(path: string, handler: Handler): void {
    this.routes[`GET ${path}`] = handler;
  }

  post(path: string, handler: Handler): void {
    this.routes[`POST ${path}`] = handler;
  }

  /** 回 true 代表已處理（含錯誤回應）；false 代表不是 API 路徑。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      checkOrigin(req, this.opts);
      const handler = this.routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new AppError('not_found');
      const body = req.method === 'POST' ? await readJsonBody(req, this.opts.bodyBytes) : {};
      const result = await handler({ req, res, query: url.searchParams, body, ip: req.socket.remoteAddress ?? '' });
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof AppError && err.code === 'too_large' && !res.headersSent) {
        // 先回 413 再斷線，避免客戶端只看到連線重設
        res.setHeader('Connection', 'close');
        res.once('finish', () => (res.socket as { destroy(): void } | null)?.destroy());
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
  if (typeof v !== 'string' || v.length === 0) throw new AppError('bad_request', `${key} 必填`);
  if (v.length > max) throw new AppError('bad_request', `${key} 過長`);
  return v;
}

export function optString(src: Record<string, unknown> | URLSearchParams, key: string, max: number): string | undefined {
  const v = src instanceof URLSearchParams ? src.get(key) : src[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppError('bad_request', `${key} 必須是字串`);
  if (v.length > max) throw new AppError('bad_request', `${key} 過長`);
  return v;
}
