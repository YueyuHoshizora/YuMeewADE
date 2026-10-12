// 靜態前端（dist/ui）。只服務目錄內的檔案；根路徑回 index.html。

import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { isInside } from '../shared/fsx.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export async function serveStatic(dir: string, req: IncomingMessage, res: ServerResponse, frameOrigin?: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel: string;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); }
  catch { res.writeHead(400).end(); return; }
  const file = path.join(dir, rel);
  if (!isInside(dir, file)) {
    res.writeHead(404).end();
    return;
  }
  let data: Buffer;
  try {
    // The lexical check above does not follow links: a symlink inside the UI folder must not serve a file outside it.
    const [root, real] = await Promise.all([fs.realpath(dir), fs.realpath(file)]);
    if (!isInside(root, real)) throw new Error('outside the UI folder');
    data = await fs.readFile(real);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  const frame = frameOrigin ? new URL(frameOrigin) : undefined;
  if (frame && (frame.protocol !== 'http:' || frame.hostname !== '127.0.0.1' || !frame.port)) throw new Error('Invalid preview gateway');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src ${frame?.origin ?? "'none'"}; frame-ancestors 'none'`,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}
