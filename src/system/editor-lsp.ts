import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AppError } from '../shared/errors.ts';

/** 原生 stdio JSON-RPC；不執行 shell，stderr 不記錄文件或憑證。 */
export class LanguageClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private serial = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  private dead = false;
  private readonly onDeath: () => void;
  readonly diagnostics = new Map<string, unknown[]>();
  readonly ready: Promise<unknown>;
  constructor(command: string[], root: string, onDeath: () => void = () => undefined) {
    this.onDeath = onDeath;
    if (!command[0]) throw new AppError('unavailable');
    this.child = spawn(command[0], command.slice(1), { cwd: root, stdio: 'pipe', shell: false });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail());
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 16 * 1024 * 1024) { this.dispose(); return; }
      for (;;) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1]);
        if (!Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024) { this.dispose(); return; }
        if (this.buffer.length < end + 4 + length) return;
        const body = this.buffer.subarray(end + 4, end + 4 + length);
        this.buffer = this.buffer.subarray(end + 4 + length);
        try { this.receive(JSON.parse(body.toString()) as Record<string, unknown>); } catch { this.dispose(); return; }
      }
    });
    this.ready = this.request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: { textDocument: { publishDiagnostics: {}, diagnostic: {} }, general: { positionEncodings: ['utf-16'] } }, workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'workspace' }] }).then(result => { this.notify('initialized', {}); return result; });
  }
  private receive(message: Record<string, unknown>): void {
    if (this.dead) return;
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new AppError('unavailable')); else pending.resolve(message.result);
    } else if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri: string; diagnostics: unknown[] };
      if (typeof params.uri !== 'string' || !Array.isArray(params.diagnostics) || params.diagnostics.length > 1000 || (!this.diagnostics.has(params.uri) && this.diagnostics.size >= 1000)) { this.dispose(); return; }
      this.diagnostics.set(params.uri, params.diagnostics);
    } else if (message.id !== undefined) {
      // 不允許 server 改檔或執行 command；唯有設定查詢提供空設定。
      const params = message.params as { items?: unknown[] } | undefined;
      this.send({ jsonrpc: '2.0', id: message.id, result: message.method === 'workspace/configuration' ? (params?.items ?? []).map(() => ({})) : null });
    }
  }
  private send(message: unknown): void { const body = Buffer.from(JSON.stringify(message)); this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); this.child.stdin.write(body); }
  notify(method: string, params: unknown): void {
    if (this.dead) throw new AppError('unavailable');
    this.send({ jsonrpc: '2.0', method, params });
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.serial;
    if (this.dead) return Promise.reject(new AppError('unavailable'));
    if (this.pending.size >= 128) return Promise.reject(new AppError('unavailable'));
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { this.pending.delete(id); reject(new AppError('unavailable')); }, 15000);
    this.pending.set(id, { resolve, reject, timer });
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }
  private fail(): void {
    if (this.dead) return;
    this.dead = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AppError('unavailable')); }
    this.pending.clear(); this.diagnostics.clear();
    this.onDeath();
  }
  dispose(): void { this.fail(); this.child.kill(); }
}
