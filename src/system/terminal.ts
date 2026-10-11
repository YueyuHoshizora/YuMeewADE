import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as pty from 'node-pty';
import { captureCommand, findExecutable, minimalEnv } from '../cli/process.ts';
import { AppError } from '../shared/errors.ts';
import type { TerminalLease, TerminalRequest, TerminalSession } from '../shared/execution-tools.ts';
import type { ExecutionService } from './commands.ts';
import { executionArgs, executionEnv } from './execution-input.ts';

export interface TerminalOptions {
  envPassthrough?: string[]; concurrent?: number; outputBytes?: number; history?: number; idleMs?: number;
  isRunning?: (project: string, task: string) => boolean;
  beforeStart?: (project: string, task: string) => Promise<void>;
}
interface Entry { view: TerminalSession; owner: Buffer; process: pty.IPty; bytes: number; touched: number; inputAt: number; inputBytes: number; done: Promise<void>; finish: () => void; stopping?: Promise<void> }
const dimension = (value: unknown, fallback: number): number => { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 2 || value > 300) throw new AppError('bad_request'); return value; };

export class TerminalService {
  private readonly execution: ExecutionService;
  private readonly options: TerminalOptions;
  private readonly sessions = new Map<string, Entry>();
  private readonly pending = new Map<string, { project: string; task: string }>();
  private closed = false;
  private readonly sweep: NodeJS.Timeout;
  constructor(execution: ExecutionService, options: TerminalOptions = {}) {
    this.execution = execution; this.options = options;
    this.sweep = setInterval(() => { for (const e of this.sessions.values()) if (e.view.status === 'running' && Date.now() - e.touched > (this.options.idleMs ?? 300_000)) void this.terminate(e).catch(() => undefined); }, 30_000);
    this.sweep.unref();
  }
  async start(project: string, task: string, request: TerminalRequest = {}): Promise<TerminalLease> {
    const cols = dimension(request.cols, 100); const rows = dimension(request.rows, 30);
    const overrides = executionEnv(request.env); const args = executionArgs(request.args);
    if (request.command !== undefined && (typeof request.command !== 'string' || !request.command || request.command.length > 4096 || /[\0\r\n]/u.test(request.command))) throw new AppError('bad_request');
    if (this.closed || this.active() + this.pending.size >= (this.options.concurrent ?? 4)) throw new AppError('unavailable');
    if (this.options.isRunning?.(project, task) || this.execution.isRunning(project, task)) throw new AppError('conflict');
    const key = randomUUID(); this.pending.set(key, { project, task });
    try {
      await this.options.beforeStart?.(project, task);
      const cwd = await this.execution.cwd(project, task, request.cwd);
      const env: NodeJS.ProcessEnv = { ...minimalEnv(this.options.envPassthrough ?? []), ...overrides, TERM: 'xterm-256color' };
      delete env['NODE_OPTIONS']; delete env['LD_PRELOAD']; delete env['DYLD_INSERT_LIBRARIES'];
      const shell = request.command ?? (process.platform === 'win32' ? process.env['ComSpec'] ?? 'cmd.exe' : process.env['SHELL'] ?? '/bin/sh');
      const command = await findExecutable(shell, env);
      if (!command) throw new AppError('unavailable', 'cli_unavailable');
      if (this.closed || this.execution.isRunning(project, task) || this.options.isRunning?.(project, task)) throw new AppError('conflict');
      for (const [id, e] of this.sessions) { if (this.sessions.size < (this.options.history ?? 64)) break; if (e.view.status !== 'running') this.sessions.delete(id); }
      if (this.sessions.size >= (this.options.history ?? 64)) throw new AppError('unavailable');
      let child: pty.IPty;
      try { child = pty.spawn(command, args, { cwd, env, cols, rows, name: 'xterm-256color', useConpty: true }); }
      catch { throw new AppError('unavailable', 'cli_unavailable'); }
      const owner = randomBytes(32); const { promise, resolve } = Promise.withResolvers<void>();
      const view: TerminalSession = { id: randomUUID(), project, task, status: 'running', cols, rows, sequence: 0, output: [], truncated: false, exitCode: null };
      const entry: Entry = { view, owner, process: child, bytes: 0, touched: Date.now(), inputAt: Date.now(), inputBytes: 0, done: promise, finish: resolve };
      this.sessions.set(view.id, entry);
      child.onData(text => this.capture(entry, text));
      child.onExit(event => { view.exitCode = event.exitCode; if (view.status === 'running') view.status = entry.stopping ? 'stopped' : 'exited'; entry.finish(); });
      return { session: this.snapshot(entry), owner: owner.toString('hex') };
    } finally { this.pending.delete(key); }
  }
  private capture(entry: Entry, text: string): void {
    const limit = this.options.outputBytes ?? 262144;
    if (Buffer.byteLength(text) > limit) { const buffer = Buffer.from(text); let start = buffer.length - limit; while ((buffer[start]! & 0xc0) === 0x80) start++; text = buffer.subarray(start).toString('utf8'); entry.view.truncated = true; }
    entry.view.output.push({ sequence: ++entry.view.sequence, text }); entry.bytes += Buffer.byteLength(text);
    while ((entry.bytes > limit || entry.view.output.length > 1024) && entry.view.output.length > 1) { entry.bytes -= Buffer.byteLength(entry.view.output.shift()!.text); entry.view.truncated = true; }
  }
  private get(project: string, task: string, id: string, owner: string): Entry {
    const e = this.sessions.get(id);
    if (!e || e.view.project !== project || e.view.task !== task) throw new AppError('not_found');
    if (typeof owner !== 'string' || !/^[a-f0-9]{64}$/u.test(owner) || !timingSafeEqual(e.owner, Buffer.from(owner, 'hex'))) throw new AppError('forbidden');
    e.touched = Date.now(); return e;
  }
  private snapshot(e: Entry, after = 0): TerminalSession { return { ...e.view, output: e.view.output.filter(o => o.sequence > after).map(o => ({ ...o })) }; }
  output(project: string, task: string, id: string, owner: string, after = 0): TerminalSession {
    if (!Number.isSafeInteger(after) || after < 0) throw new AppError('bad_request');
    return this.snapshot(this.get(project, task, id, owner), after);
  }
  input(project: string, task: string, id: string, owner: string, text: string): void {
    const e = this.get(project, task, id, owner);
    if (e.view.status !== 'running') throw new AppError('conflict');
    if (typeof text !== 'string' || text.length > 16384) throw new AppError('bad_request');
    if (Date.now() - e.inputAt > 1000) { e.inputAt = Date.now(); e.inputBytes = 0; }
    e.inputBytes += Buffer.byteLength(text); if (e.inputBytes > 65536) throw new AppError('unavailable');
    e.process.write(text);
  }
  resize(project: string, task: string, id: string, owner: string, cols: number, rows: number): void {
    const e = this.get(project, task, id, owner); cols = dimension(cols, 100); rows = dimension(rows, 30);
    if (e.view.status !== 'running') throw new AppError('conflict');
    e.process.resize(cols, rows); e.view.cols = cols; e.view.rows = rows;
  }
  async stop(project: string, task: string, id: string, owner: string): Promise<void> { await this.terminate(this.get(project, task, id, owner)); }
  private async terminate(e: Entry): Promise<void> {
    if (e.stopping) return e.stopping;
    if (e.view.status !== 'running') return;
    e.stopping = (async () => {
      // Interactive shells create separate foreground job groups. Snapshot descendants before killing the shell.
      if (process.platform !== 'win32') {
        const result = await captureCommand({ command: 'ps', args: ['-axo', 'pid=,ppid='], env: minimalEnv([]), timeoutMs: 2000, maxOutputBytes: 1_048_576 });
        if (result.ok) {
          const processes = result.stdout.split('\n').map(line => line.trim().split(/\s+/u).map(Number)).filter(parts => parts.length === 2 && parts.every(n => Number.isSafeInteger(n) && n > 0));
          const descendants = new Set<number>([e.process.pid]);
          for (let changed = true; changed;) { changed = false; for (const [pid, parent] of processes) if (descendants.has(parent!) && !descendants.has(pid!)) { descendants.add(pid!); changed = true; } }
          for (const pid of [...descendants].reverse()) { try { process.kill(-pid, 'SIGKILL'); } catch { /* Not every descendant leads a group. */ } try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
        }
      } else { await captureCommand({ command: 'taskkill', args: ['/pid', String(e.process.pid), '/T', '/F'], env: minimalEnv([]), timeoutMs: 3000, maxOutputBytes: 4096 }); }
      try { e.process.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch { /* Exit raced stop. */ }
      const timer = setTimeout(e.finish, 1500);
      try { await e.done; } finally { clearTimeout(timer); e.view.status = 'stopped'; }
    })();
    return e.stopping;
  }
  active(): number { return [...this.sessions.values()].filter(e => e.view.status === 'running').length; }
  isBusy(): boolean { return this.pending.size > 0 || this.active() > 0; }
  isRunning(project: string, task?: string): boolean { return [...this.pending.values()].some(e => e.project === project && (task === undefined || e.task === task)) || [...this.sessions.values()].some(e => e.view.project === project && (task === undefined || e.view.task === task) && e.view.status === 'running'); }
  close(): void { this.closed = true; clearInterval(this.sweep); for (const e of this.sessions.values()) void this.terminate(e).catch(() => undefined); }
  async stopAll(): Promise<void> { this.closed = true; clearInterval(this.sweep); await Promise.all([...this.sessions.values()].map(e => this.terminate(e))); }
}
