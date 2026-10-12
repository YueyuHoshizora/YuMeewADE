import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { findExecutable, killDescendants, minimalEnv, signalTree, spawnCli } from '../cli/process.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';
import type { ExecutionRun, ExecutionOutput, ExecutionRequest } from '../shared/types.ts';
import type { RunConfiguration } from '../shared/execution-tools.ts';
import { atomicWrite, withFileLocks } from '../shared/fsx.ts';
import { executionArgs, executionEnv } from './execution-input.ts';

export interface ExecutionOptions {
  ws: Workspace; projects: ProjectLedger; tasks: TaskLedger;
  concurrent?: number; outputBytes?: number; timeoutMs?: number; previewTimeoutMs?: number; history?: number; envPassthrough?: string[];
  isRunning?: (project: string, task: string) => boolean;
  beforeStart?: (project: string, task: string) => Promise<void>;
}
interface Entry { view: ExecutionRun; cwd: string; child?: ChildProcess; done: Promise<void>; finish: () => void; timer?: NodeJS.Timeout; stopping: boolean; bytes: number; inspectorText?: string; }

export class ExecutionService {
  private readonly runs = new Map<string, Entry>();
  private pending = 0;
  private readonly pendingTasks = new Set<string>();
  private closed = false;
  private readonly options: ExecutionOptions;
  constructor(options: ExecutionOptions) { this.options = options; }

  async cwd(project: string, task: string, relative = ''): Promise<string> {
    const { ws, projects, tasks } = this.options;
    ws.taskFile(project, task);
    const [p, t] = await Promise.all([projects.get(project), tasks.get(project, task)]);
    const body = await fs.realpath(projects.bodyPath(p)).catch(() => null);
    const root = await fs.realpath(ws.root);
    const cwd = await fs.realpath(t.workdir || projects.bodyPath(p)).catch(() => null);
    if (!cwd || !(await fs.stat(cwd)).isDirectory() || !(cwd === root || isInside(root, cwd) || (body && (cwd === body || isInside(body, cwd))))) throw new AppError('bad_request');
    // A workdir supplied by the ledger must stay inside its project's body or this task's worktree.
    if (t.workdir) {
      const worktree = await fs.realpath(ws.worktreeDir(project, task)).catch(() => null);
      if (!(body && (cwd === body || isInside(body, cwd))) && !(worktree && (cwd === worktree || isInside(worktree, cwd)))) throw new AppError('bad_request');
    }
    if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\0') || path.isAbsolute(relative)) throw new AppError('bad_request');
    if (!relative) return cwd;
    const target = await fs.realpath(path.resolve(cwd, relative)).catch(() => null);
    if (!target || !(target === cwd || isInside(cwd, target)) || !(await fs.stat(target)).isDirectory()) throw new AppError('bad_request');
    return target;
  }

  async start(project: string, task: string, request: ExecutionRequest): Promise<ExecutionRun> {
    this.validate(request);
    if (this.closed || this.pending + this.active() >= (this.options.concurrent ?? 4)) throw new AppError('unavailable');
    if (this.options.isRunning?.(project, task) || this.isRunning(project, task)) throw new AppError('conflict');
    const key = JSON.stringify([project, task]);
    this.pendingTasks.add(key);
    this.pending++;
    try {
      await this.options.beforeStart?.(project, task);
      const cwd = await this.cwd(project, task, request.cwd);
      const env = { ...minimalEnv(this.options.envPassthrough ?? []), ...executionEnv(request.env) };
      if (request.kind === 'debug') { delete env['NODE_OPTIONS']; delete env['NODE_PATH']; }
      // Inspector is deliberately bound to loopback; no request can choose a public bind address.
      const requested = /[/\\]/u.test(request.command) ? path.resolve(cwd, request.command) : request.command;
      const command = request.kind === 'debug' ? process.execPath : await findExecutable(requested, env);
      if (!command) throw new AppError('unavailable', 'cli_unavailable', { field: 'command' });
      if (this.closed || this.options.isRunning?.(project, task)) throw new AppError('conflict');
      this.prune();
      const id = randomUUID();
      const { promise, resolve } = Promise.withResolvers<void>();
      const view: ExecutionRun = { id, project, task, kind: request.kind ?? 'command', command: request.command, args: request.args ?? [], status: 'running', startedAt: new Date().toISOString(), exitCode: null, timedOut: false, truncated: false, output: [], sequence: 0 };
      const entry: Entry = { view, cwd, done: promise, finish: resolve, stopping: false, bytes: 0 };
      this.runs.set(id, entry);
      const args = request.kind === 'debug' ? ['--inspect-brk=127.0.0.1:0', ...(request.args ?? [])] : request.args ?? [];
      const child = spawnCli(command, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      entry.child = child;
      let settled = false;
      const finish = (code: number | null, failed = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(entry.timer);
        // Kill surviving descendants even if the parent exits first.
        signalTree(child, 'SIGKILL');
        view.exitCode = code;
        view.status = entry.stopping ? 'stopped' : failed ? 'failed' : 'exited';
        view.finishedAt = new Date().toISOString();
        entry.finish();
      };
      for (const stream of ['stdout', 'stderr'] as const) {
        const decoder = new StringDecoder('utf8');
        child[stream]?.on('data', (chunk: Buffer) => this.capture(entry, stream, decoder.write(chunk)));
        child[stream]?.on('end', () => this.capture(entry, stream, decoder.end()));
      }
      child.once('error', () => finish(null, true));
      child.once('exit', () => signalTree(child, 'SIGKILL'));
      child.once('close', code => finish(code));
      const max = view.kind === 'preview' ? this.options.previewTimeoutMs ?? 86_400_000 : this.options.timeoutMs ?? 600_000;
      entry.timer = setTimeout(() => { view.timedOut = true; void this.stop(project, task, id); }, max);
      entry.timer.unref();
      return this.snapshot(entry);
    } finally { this.pending--; this.pendingTasks.delete(key); }
  }

  private validate(request: ExecutionRequest): void {
    if (!request || typeof request.command !== 'string' || !request.command || request.command.length > 4096 || /[\0\r\n]/u.test(request.command) || (request.kind !== undefined && !['command', 'preview', 'debug'].includes(request.kind))) throw new AppError('bad_request');
    executionArgs(request.args);
    executionEnv(request.env);
    if (request.cwd !== undefined && (typeof request.cwd !== 'string' || request.cwd.length > 4096)) throw new AppError('bad_request');
    if (request.kind === 'debug' && (request.command !== 'node' || !(request.args?.length) || request.args.some(a => /^--inspect|^--debug|^--host/u.test(a)))) throw new AppError('bad_request');
  }

  private async configFile(project: string, task: string): Promise<string> {
    this.options.ws.taskFile(project, task);
    const projectRoot = await fs.realpath(this.options.ws.projectDir(project));
    const ai = await fs.realpath(path.join(projectRoot, '.ai'));
    if (!isInside(projectRoot, ai)) throw new AppError('bad_request');
    const folder = path.join(ai, 'run-configs');
    await fs.mkdir(folder, { recursive: true });
    if (!isInside(projectRoot, await fs.realpath(folder))) throw new AppError('bad_request');
    const file = path.join(folder, `${task}.json`);
    const stat = await fs.lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new AppError('bad_request');
    return file;
  }
  private configuration(value: unknown): RunConfiguration {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request');
    const v = value as Record<string, unknown>;
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80 || /[\0\r\n]/u.test(v.name)) throw new AppError('bad_request');
    const request: ExecutionRequest = { command: v.command as string, args: executionArgs(v.args), ...(v.kind !== undefined ? { kind: v.kind as NonNullable<ExecutionRequest['kind']> } : {}), ...(v.cwd !== undefined ? { cwd: v.cwd as string } : {}), env: executionEnv(v.env) };
    this.validate(request);
    return { name: v.name, command: request.command, args: request.args ?? [], kind: request.kind ?? 'command', cwd: request.cwd ?? '', env: request.env ?? {} };
  }
  private async readConfigurations(file: string): Promise<RunConfiguration[]> {
    let handle: FileHandle;
    try { handle = await fs.open(file, 'r'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      if ((await handle.stat()).size > 1_048_576) throw new AppError('bad_request');
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!Array.isArray(value) || value.length > 50) throw new AppError('bad_request');
      return value.map(v => this.configuration(v));
    } finally { await handle.close(); }
  }
  async configurations(project: string, task: string): Promise<RunConfiguration[]> { await this.cwd(project, task); return this.readConfigurations(await this.configFile(project, task)); }
  async saveConfiguration(project: string, task: string, value: unknown): Promise<RunConfiguration[]> {
    const config = this.configuration(value);
    await this.cwd(project, task, config.cwd);
    const file = await this.configFile(project, task);
    return withFileLocks([file], async () => {
      const configs = await this.readConfigurations(file);
      const index = configs.findIndex(c => c.name === config.name);
      if (index < 0) { if (configs.length >= 50) throw new AppError('unavailable'); configs.push(config); } else configs[index] = config;
      const serialized = JSON.stringify(configs) + '\n';
      if (Buffer.byteLength(serialized) > 1_048_576) throw new AppError('bad_request');
      await atomicWrite(file, serialized);
      await fs.chmod(file, 0o600);
      return configs;
    });
  }
  async removeConfiguration(project: string, task: string, name: string): Promise<RunConfiguration[]> {
    await this.cwd(project, task);
    const file = await this.configFile(project, task);
    return withFileLocks([file], async () => {
      const configs = (await this.readConfigurations(file)).filter(c => c.name !== name);
      await atomicWrite(file, JSON.stringify(configs) + '\n'); await fs.chmod(file, 0o600);
      return configs;
    });
  }
  async startConfiguration(project: string, task: string, name: string): Promise<ExecutionRun> {
    const config = (await this.configurations(project, task)).find(c => c.name === name);
    if (!config) throw new AppError('not_found');
    return this.start(project, task, config);
  }
  private capture(entry: Entry, stream: 'stdout' | 'stderr', text: string): void {
    if (!text) return;
    if (entry.view.kind === 'debug' && stream === 'stderr' && !entry.view.inspectorUrl) {
      entry.inspectorText = ((entry.inspectorText ?? '') + text).slice(-4096);
      const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)(?:\r?\n)/u.exec(entry.inspectorText);
      if (match?.[1]) entry.view.inspectorUrl = match[1];
    }
    const limit = this.options.outputBytes ?? 262144;
    if (Buffer.byteLength(text) > limit) { const bytes = Buffer.from(text); let start = bytes.length - limit; while ((bytes[start]! & 0xc0) === 0x80) start++; text = bytes.subarray(start).toString(); entry.view.truncated = true; }
    const event: ExecutionOutput = { sequence: ++entry.view.sequence, stream, text };
    entry.view.output.push(event); entry.bytes += Buffer.byteLength(text);
    while ((entry.bytes > limit || entry.view.output.length > 1024) && entry.view.output.length > 1) { entry.bytes -= Buffer.byteLength(entry.view.output.shift()!.text); entry.view.truncated = true; }
  }
  private snapshot(entry: Entry, after = 0): ExecutionRun { return { ...entry.view, args: [...entry.view.args], output: entry.view.output.filter(o => o.sequence > after).map(o => ({ ...o })) }; }
  private get(project: string, task: string, id: string): Entry { this.options.ws.taskFile(project, task); const entry = this.runs.get(id); if (!entry || entry.view.project !== project || entry.view.task !== task) throw new AppError('not_found'); return entry; }
  list(project: string, task: string): ExecutionRun[] { this.options.ws.taskFile(project, task); return [...this.runs.values()].filter(e => e.view.project === project && e.view.task === task).map(e => this.snapshot(e)); }
  output(project: string, task: string, id: string, after = 0): ExecutionRun { if (!Number.isSafeInteger(after) || after < 0) throw new AppError('bad_request'); return this.snapshot(this.get(project, task, id), after); }
  runDirectory(project: string, task: string, id: string): string { return this.get(project, task, id).cwd; }
  async stop(project: string, task: string, id: string): Promise<void> {
    const entry = this.get(project, task, id);
    if (entry.view.status !== 'running') return;
    entry.stopping = true;
    // A descendant started in its own group or session (`detached`) escapes the group signal; find it while it is still linked to this run.
    if (entry.child?.pid) await killDescendants(entry.child.pid);
    if (entry.child) signalTree(entry.child, 'SIGKILL');
    const bound = setTimeout(() => { entry.child?.stdout?.destroy(); entry.child?.stderr?.destroy(); entry.child?.unref(); entry.view.status = 'stopped'; entry.view.finishedAt = new Date().toISOString(); entry.finish(); }, 1500);
    try { await entry.done; } finally { clearTimeout(bound); clearTimeout(entry.timer); }
  }
  active(): number { return [...this.runs.values()].filter(e => e.view.status === 'running').length; }
  isBusy(): boolean { return this.pending > 0 || this.active() > 0; }
  isRunning(project: string, task?: string): boolean {
    const pending = task === undefined
      ? [...this.pendingTasks].some(key => (JSON.parse(key) as string[])[0] === project)
      : this.pendingTasks.has(JSON.stringify([project, task]));
    return pending || [...this.runs.values()].some(entry => entry.view.project === project && (task === undefined || entry.view.task === task) && entry.view.status === 'running');
  }
  private prune(): void { const limit = this.options.history ?? 100; for (const [id, entry] of this.runs) { if (this.runs.size < limit) break; if (entry.view.status !== 'running') this.runs.delete(id); } if (this.runs.size >= limit) throw new AppError('unavailable'); }
  close(): void { this.closed = true; for (const e of this.runs.values()) if (e.view.status === 'running' && e.child) signalTree(e.child, 'SIGKILL'); }
  async stopAll(): Promise<void> { this.closed = true; await Promise.all([...this.runs.values()].map(e => this.stop(e.view.project, e.view.task, e.view.id))); }
}
