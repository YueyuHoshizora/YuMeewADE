import type { ChildProcess } from 'node:child_process';
import { AppError } from '../shared/errors.ts';
import { terminateTree } from '../cli/process.ts';

type Message = Record<string, unknown>;
export class DapTransport {
  private buffer = Buffer.alloc(0);
  private length: number | undefined;
  private next = 0;
  private closed = false;
  private pending = new Map<number, { command: string; resolve: (body: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private cancelKill: (() => void) | undefined;
  private readonly child: ChildProcess;
  private readonly event: (name: string, body: Message) => void;
  private readonly failed: (reason: 'timeout' | 'malformed' | 'exit' | 'transport') => void;
  constructor(child: ChildProcess, event: (name: string, body: Message) => void, failed: (reason: 'timeout' | 'malformed' | 'exit' | 'transport') => void) {
    this.child = child; this.event = event; this.failed = failed;
    child.stdout?.on('data', (data: Buffer) => this.receive(data));
    child.stdout?.on('error', () => this.fail('transport'));
    child.stdin?.on('error', () => this.fail('transport'));
    child.on('error', () => this.fail('transport'));
    child.on('exit', () => { this.cancelKill?.(); if (!this.closed) this.fail('exit'); });
    let stderrBytes = 0;
    child.stderr?.on('data', (data: Buffer) => { stderrBytes += data.length; if (stderrBytes > 1_048_576) this.fail('transport'); });
  }
  request(command: string, args: Message = {}): Promise<Message> {
    if (this.closed) return Promise.reject(new AppError('conflict'));
    if (this.pending.size >= 32) return Promise.reject(new AppError('unavailable'));
    const seq = ++this.next;
    const gate = Promise.withResolvers<Message>();
    const timer = setTimeout(() => this.fail('timeout'), 15_000);
    this.pending.set(seq, { command, ...gate, timer });
    this.send({ seq, type: 'request', command, arguments: args });
    return gate.promise;
  }
  private send(message: Message): void {
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > 1_048_576 || (this.child.stdin?.writableLength ?? 0) > 1_048_576) { this.fail('transport'); return; }
    this.child.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  private receive(data: Buffer): void {
    if (this.closed) return;
    if (this.buffer.length + data.length > 2_097_152) { this.fail('malformed'); return; }
    this.buffer = Buffer.concat([this.buffer, data]);
    try {
      while (!this.closed) {
        if (this.length === undefined) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (this.buffer.length > 8192) this.fail('malformed'); return; }
          const header = this.buffer.subarray(0, end).toString('ascii');
          const lines = header.split('\r\n');
          const lengths = lines.filter(line => /^Content-Length:/iu.test(line));
          if (end > 8192 || lengths.length !== 1 || !/^Content-Length: [1-9][0-9]*$/iu.test(lengths[0]!)) throw new Error();
          this.length = Number(lengths[0]!.split(':')[1]);
          if (!Number.isSafeInteger(this.length) || this.length > 1_048_576) throw new Error();
          this.buffer = this.buffer.subarray(end + 4);
        }
        if (this.buffer.length < this.length) return;
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.length)));
        this.buffer = this.buffer.subarray(this.length); this.length = undefined;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        const message = parsed as Message;
        if (!Number.isSafeInteger(message.seq) || (message.seq as number) < 0) throw new Error();
        if (message.type === 'response') {
          if (!Number.isSafeInteger(message.request_seq) || typeof message.success !== 'boolean') throw new Error();
          const pending = this.pending.get(message.request_seq as number);
          if (!pending) continue;
          if (message.command !== pending.command) throw new Error();
          clearTimeout(pending.timer); this.pending.delete(message.request_seq as number);
          if (message.success) pending.resolve(object(message.body)); else pending.reject(new AppError('bad_request', undefined, { field: pending.command }));
        } else if (message.type === 'event' && typeof message.event === 'string') this.event(message.event, object(message.body));
        else if (message.type === 'request' && typeof message.command === 'string') {
          // No runInTerminal, startDebugging, arbitrary child launch, or endpoint negotiation.
          this.send({ seq: ++this.next, type: 'response', request_seq: message.seq, command: message.command, success: false, message: 'Reverse requests are not supported' });
        } else throw new Error();
      }
    } catch { this.fail('malformed'); }
  }
  private fail(reason: 'timeout' | 'malformed' | 'exit' | 'transport'): void { if (this.closed) return; this.close(reason); this.failed(reason); }
  close(reason?: string): void {
    if (this.closed) return; this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new AppError('unavailable', undefined, { ...(reason ? { field: reason } : {}) })); }
    this.pending.clear(); this.buffer = Buffer.alloc(0);
    this.cancelKill = terminateTree(this.child, () => undefined);
  }
}
export function object(value: unknown): Message { return value && typeof value === 'object' && !Array.isArray(value) ? value as Message : {}; }
