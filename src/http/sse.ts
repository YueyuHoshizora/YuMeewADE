// SSE 連線管理：每個作業一條流＋一條全域流（key GLOBAL）；連線數上限、心跳、斷線清理、背壓。
// 背壓：res.write 回 false 代表客戶端讀太慢；超過 MAX_BUFFERED 位元組就斷線，由客戶端重連補狀態。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';
import type { ChatEvent, GlobalEvent } from '../shared/types.ts';

export const GLOBAL = '*';
const MAX_BUFFERED = 4 * 1024 * 1024;

interface Conn {
  key: string;
  res: ServerResponse;
}

export class SseHub {
  private readonly conns = new Set<Conn>();
  private readonly limit: number;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(limit: number, heartbeatMs: number) {
    this.limit = limit;
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) this.write(c, ': ping\n\n');
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.conns.size;
  }

  /** 開啟一條流並先送 ready；超過上限回 503。 */
  open(req: IncomingMessage, res: ServerResponse, key: string, ready: ChatEvent | GlobalEvent): void {
    if (this.conns.size >= this.limit) throw new AppError('unavailable', 'sse_limit');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.flushHeaders();
    const conn: Conn = { key, res };
    this.conns.add(conn);
    res.write(`retry: 2000\n`);
    this.write(conn, format(ready));
    req.on('close', () => this.conns.delete(conn));
  }

  publish(key: string, ev: ChatEvent | GlobalEvent): void {
    const payload = format(ev);
    for (const c of this.conns) if (c.key === key) this.write(c, payload);
  }

  private write(c: Conn, payload: string): void {
    if (c.res.writableEnded || c.res.destroyed) {
      this.conns.delete(c);
      return;
    }
    if (c.res.writableLength > MAX_BUFFERED) {
      log.warn('SSE 客戶端讀取過慢，斷線', { key: c.key === GLOBAL ? GLOBAL : 'task' });
      c.res.destroy();
      this.conns.delete(c);
      return;
    }
    c.res.write(payload);
  }

  closeAll(): void {
    clearInterval(this.heartbeat);
    for (const c of this.conns) c.res.end();
    this.conns.clear();
  }
}

/** 作業對話流的 key。 */
export function taskKey(project: string, task: string): string {
  return `${project}\u0000${task}`;
}

function format(ev: { event: string; data: unknown }): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
