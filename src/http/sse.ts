// SSE 連線管理：每個作業一條流；連線數上限、心跳、斷線清理。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../shared/errors.ts';
import type { SseEvent } from '../shared/types.ts';

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
      for (const c of this.conns) c.res.write(': ping\n\n');
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.conns.size;
  }

  /** 開啟一條流並先送 ready；超過上限回 503。 */
  open(req: IncomingMessage, res: ServerResponse, key: string, ready: SseEvent): void {
    if (this.conns.size >= this.limit) throw new AppError('unavailable', 'SSE 連線數已達上限');
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
    res.write(format(ready));
    req.on('close', () => this.conns.delete(conn));
  }

  publish(key: string, ev: SseEvent): void {
    const payload = format(ev);
    for (const c of this.conns) if (c.key === key) c.res.write(payload);
  }

  closeAll(): void {
    clearInterval(this.heartbeat);
    for (const c of this.conns) c.res.end();
    this.conns.clear();
  }
}

function format(ev: SseEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
