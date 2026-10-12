import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import type { DebugAction, DebugSession, DebugValue, DebugBreakpoint } from '../shared/execution-tools.ts';
import type { DapLaunch, DapSession } from '../shared/dap.ts';
import type { ExecutionService } from './commands.ts';
import type { DebuggerOptions } from './debugger.ts';
import { debugFile } from './debug-source-maps.ts';
import { executionArgs } from './execution-input.ts';
import { findExecutable, minimalEnv, spawnCli } from '../cli/process.ts';
import { DapTransport, object } from './dap-transport.ts';

const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 8192) : '';
const integer = (value: unknown): number => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0;

interface Entry { view: DapSession; root: string; transport: DapTransport; thread: number; objects: Map<string, { ref: number; frame: number }>; version: number; busy: boolean; closed: boolean; initialized: { promise: Promise<void>; resolve: () => void; reject: (reason: Error) => void }; timer: NodeJS.Timeout }
export class DapDebugger {
  private sessions = new Map<string, Entry>();
  private closed = false;
  private readonly launching = new Map<string, { project: string; task: string }>();
  private readonly execution: ExecutionService;
  private readonly options: DebuggerOptions;
  constructor(execution: ExecutionService, options: DebuggerOptions) { this.execution = execution; this.options = options; }
  has(id: string): boolean { return this.sessions.has(id); }
  isRunning(project: string, task?: string): boolean {
    return [...this.launching.values()].some(e => e.project === project && (task === undefined || e.task === task)) || [...this.sessions.values()].some(e => !e.closed && e.view.project === project && (task === undefined || e.view.task === task));
  }
  isBusy(): boolean { return this.launching.size > 0 || [...this.sessions.values()].some(e => !e.closed); }
  private get(project: string, task: string, id: string): Entry {
    const e = this.sessions.get(id); if (!e || e.view.project !== project || e.view.task !== task) throw new AppError('not_found'); return e;
  }
  state(project: string, task: string, id: string): DapSession { return structuredClone(this.get(project, task, id).view); }
  async launch(project: string, task: string, input: DapLaunch): Promise<DapSession> {
    await this.options.beforeLaunch?.(project, task);
    await this.options.beforeMutate?.(project, task);
    if (this.closed || this.launching.size + [...this.sessions.values()].filter(e => !e.closed).length >= 8) throw new AppError('unavailable');
    if (this.isRunning(project, task)) throw new AppError('conflict');
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['adapter', 'type', 'program', 'args', 'stopOnEntry', 'breakpoints'].includes(key))) throw new AppError('bad_request');
    const argv = executionArgs(input.adapter);
    if (!argv.length || typeof input.type !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/u.test(input.type) || typeof input.program !== 'string' || (input.stopOnEntry !== undefined && typeof input.stopOnEntry !== 'boolean')) throw new AppError('bad_request');
    if (argv.some(arg => /^(?:--?(?:host|port|listen|connect|tcp|server|attach)|-p)(?:=|$)/iu.test(arg))) throw new AppError('bad_request', undefined, { field: 'adapter' });
    const args = executionArgs(input.args);
    if (input.breakpoints !== undefined && (!Array.isArray(input.breakpoints) || input.breakpoints.length > 128)) throw new AppError('bad_request');
    for (const point of input.breakpoints ?? []) if (!point || typeof point !== 'object' || typeof point.path !== 'string' || !integer(point.line) || point.line > 1_000_000 || (point.condition !== undefined && (typeof point.condition !== 'string' || point.condition.length > 512 || /[\0\r\n]/u.test(point.condition)))) throw new AppError('bad_request');
    const reservation = JSON.stringify([project, task]);
    this.launching.set(reservation, { project, task });
    try {
      const root = await this.execution.cwd(project, task); const program = await debugFile(root, input.program);
      if (!(await fs.stat(program)).isFile()) throw new AppError('bad_request');
      for (const point of input.breakpoints ?? []) await debugFile(root, point.path);
      const env = minimalEnv([]); delete env['NODE_OPTIONS']; delete env['NODE_PATH']; delete env['PYTHONPATH'];
      const command = await findExecutable(/[/\\]/u.test(argv[0]!) ? path.resolve(root, argv[0]!) : argv[0]!, env);
      if (!command) throw new AppError('unavailable', 'cli_unavailable', { field: 'adapter' });
      await this.options.beforeMutate?.(project, task);
      if (this.closed) throw new AppError('unavailable');
      const id = randomUUID();
      const view: DapSession = { id, project, task, run: id, protocol: 'dap', status: 'connecting', reason: '', frames: [], scripts: [], breakpoints: [], revision: 0, capabilities: { conditionalBreakpoints: false, evaluate: false, configurationDone: false, terminate: false } };
      const initialized = Promise.withResolvers<void>();
      // Observe the gate immediately: exit can precede the initialize response.
      void initialized.promise.catch(() => undefined);
      const child = spawnCli(command, argv.slice(1), { cwd: root, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const e: Entry = { view, root, thread: 0, objects: new Map(), version: 0, busy: false, closed: false, initialized, transport: undefined as unknown as DapTransport, timer: setTimeout(() => this.end(e, 'timeout'), 3_600_000) };
      e.transport = new DapTransport(child, (event, body) => this.event(e, event, body), reason => this.end(e, reason));
      for (const [oldId, old] of this.sessions) if (old.closed && this.sessions.size >= 64) this.sessions.delete(oldId);
      this.sessions.set(id, e);
      try {
        const caps = await e.transport.request('initialize', { clientID: 'yumeewade', adapterID: input.type, pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsRunInTerminalRequest: false, supportsStartDebuggingRequest: false, supportsVariablePaging: true });
        view.capabilities = { conditionalBreakpoints: caps.supportsConditionalBreakpoints === true, evaluate: caps.supportsEvaluateForHovers === true, configurationDone: caps.supportsConfigurationDoneRequest === true, terminate: caps.supportsTerminateRequest === true };
        if (!view.capabilities.configurationDone) { this.end(e, 'unsupported'); throw new AppError('bad_request', undefined, { field: 'configurationDone' }); }
        const launch = e.transport.request('launch', { type: input.type, request: 'launch', program, args, cwd: root, stopOnEntry: input.stopOnEntry ?? true, console: 'internalConsole', terminal: 'internal', env: {} });
        void launch.catch(() => undefined);
        const gateTimer = setTimeout(() => this.end(e, 'timeout'), 15_000);
        try { await initialized.promise; } finally { clearTimeout(gateTimer); }
        for (const point of input.breakpoints ?? []) await this.breakpoint(project, task, id, point.path, point.line, point.condition);
        await e.transport.request('configurationDone'); await launch;
        if (view.status === 'connecting') view.status = 'running';
        return structuredClone(view);
      } catch (error) { this.end(e, e.view.diagnostic ?? 'transport'); throw error; }
    } finally { this.launching.delete(reservation); }
  }
  private event(e: Entry, name: string, body: Record<string, unknown>): void {
    if (e.closed) return;
    if (name === 'initialized') e.initialized.resolve();
    else if (name === 'stopped') {
      e.thread = integer(body.threadId); e.view.status = 'paused'; e.view.reason = text(body.reason); e.view.frames = []; e.objects.clear(); const version = ++e.version;
      void this.stack(e, version).catch(() => this.end(e, 'transport'));
    } else if (name === 'continued') { e.view.status = 'running'; e.view.frames = []; e.objects.clear(); e.version++; }
    else if (name === 'terminated' || name === 'exited') this.end(e);
    else if (name === 'breakpoint') {
      const point = object(body.breakpoint); const found = e.view.breakpoints.find(p => p.id === String(point.id));
      if (found) found.locations = point.verified === true ? [{ scriptId: found.path, line: integer(point.line) || found.line, column: 1 }] : [];
    }
  }
  private async stack(e: Entry, version: number): Promise<void> {
    if (!e.thread) {
      const threads = await e.transport.request('threads');
      e.thread = Array.isArray(threads.threads) ? integer(object(threads.threads[0]).id) : 0;
    }
    if (!e.thread) throw new AppError('unavailable');
    const result = await e.transport.request('stackTrace', { threadId: e.thread, startFrame: 0, levels: 64 });
    if (!Array.isArray(result.stackFrames)) { this.end(e, 'malformed'); throw new AppError('unavailable', undefined, { field: 'stackTrace' }); }
    const frames: DebugSession['frames'] = [];
    const objects: Entry['objects'] = new Map();
    for (const item of Array.isArray(result.stackFrames) ? result.stackFrames.slice(0, 64) : []) {
      const frame = object(item); if (!Number.isSafeInteger(frame.id) || (frame.id as number) < 0) continue;
      const source = object(frame.source); let relative = '';
      if (typeof source.path === 'string') {
        try { const file = await debugFile(e.root, path.relative(e.root, source.path).split(path.sep).join('/')); relative = path.relative(e.root, file).split(path.sep).join('/'); } catch { /* Outside-workspace sources are not exposed. */ }
      }
      const scopes = await e.transport.request('scopes', { frameId: frame.id });
      if (!Array.isArray(scopes.scopes)) { this.end(e, 'malformed'); throw new AppError('unavailable', undefined, { field: 'scopes' }); }
      frames.push({ id: String(frame.id), name: text(frame.name), url: relative, location: { scriptId: relative, line: integer(frame.line) || 1, column: integer(frame.column) || 1, ...(relative ? { source: { path: relative, line: integer(frame.line) || 1, column: integer(frame.column) || 1 } } : {}) }, scopes: (Array.isArray(scopes.scopes) ? scopes.scopes.slice(0, 16) : []).map(value => {
        const scope = object(value); const ref = integer(scope.variablesReference); const key = `${frame.id}:${ref}`;
        if (ref && objects.size < 2048) objects.set(key, { ref, frame: frame.id as number });
        return { name: text(scope.name), type: text(scope.presentationHint), ...(ref && objects.has(key) ? { objectId: key } : {}) };
      }) });
    }
    if (e.closed || e.version !== version || e.view.status !== 'paused') return;
    e.objects = objects;
    e.view.frames = frames; e.view.scripts = [...new Set(frames.map(f => f.url).filter(Boolean))].map(relative => ({ id: relative, path: relative, url: relative }));
  }
  async action(project: string, task: string, id: string, action: DebugAction): Promise<DapSession> {
    await this.options.beforeMutate?.(project, task); const e = this.get(project, task, id);
    const commands: Record<DebugAction, string> = { pause: 'pause', resume: 'continue', stepOver: 'next', stepInto: 'stepIn', stepOut: 'stepOut' };
    if (!Object.hasOwn(commands, action) || (action === 'pause' ? e.view.status !== 'running' : e.view.status !== 'paused')) throw new AppError('bad_request');
    if (!e.thread) { const result = await e.transport.request('threads'); e.thread = Array.isArray(result.threads) ? integer(object(result.threads[0]).id) : 0; }
    if (!e.thread) throw new AppError('conflict');
    const version = e.version;
    await e.transport.request(commands[action], { threadId: e.thread });
    // DAP adapters may omit continued for a client-issued resume/step.
    if (action !== 'pause' && e.version === version && e.view.status === 'paused') { e.view.status = 'running'; e.view.frames = []; e.objects.clear(); e.version++; }
    return this.state(project, task, id);
  }
  async breakpoint(project: string, task: string, id: string, relative: string, line: number, condition?: string, revision?: number): Promise<DapSession> {
    await this.options.beforeMutate?.(project, task); const e = this.get(project, task, id);
    if (!integer(line) || line > 1_000_000 || e.view.breakpoints.length >= 128 || (condition !== undefined && (typeof condition !== 'string' || condition.length > 512 || /[\0\r\n]/u.test(condition)))) throw new AppError('bad_request');
    if (condition && !e.view.capabilities.conditionalBreakpoints) throw new AppError('bad_request', undefined, { field: 'conditionalBreakpoints' });
    const file = await debugFile(e.root, relative); const canonical = path.relative(e.root, file).split(path.sep).join('/');
    const points = e.view.breakpoints.filter(p => p.path === canonical);
    if (!points.some(p => p.line === line)) points.push({ id: randomUUID(), path: canonical, line, ...(condition ? { condition } : {}), locations: [] });
    await this.setBreakpoints(e, canonical, points, revision); return this.state(project, task, id);
  }
  async removeBreakpoint(project: string, task: string, id: string, pointId: string, revision?: number): Promise<DapSession> {
    await this.options.beforeMutate?.(project, task); const e = this.get(project, task, id); const point = e.view.breakpoints.find(p => p.id === pointId);
    if (!point) throw new AppError('not_found');
    await this.setBreakpoints(e, point.path, e.view.breakpoints.filter(p => p.path === point.path && p.id !== pointId), revision); return this.state(project, task, id);
  }
  private async setBreakpoints(e: Entry, relative: string, points: DebugBreakpoint[], revision?: number): Promise<void> {
    if (e.closed || e.busy || (revision !== undefined && revision !== e.view.revision)) throw new AppError('conflict'); e.busy = true;
    try {
      const result = await e.transport.request('setBreakpoints', { source: { path: await debugFile(e.root, relative) }, breakpoints: points.map(({ line, condition }) => ({ line, ...(condition ? { condition } : {}) })), sourceModified: false });
      if (!Array.isArray(result.breakpoints) || result.breakpoints.length !== points.length) { this.end(e, 'malformed'); throw new AppError('unavailable'); }
      for (let index = 0; index < points.length; index++) { const bound = object(result.breakpoints[index]); const point = points[index]!; point.id = integer(bound.id) ? String(bound.id) : point.id; point.locations = bound.verified === true ? [{ scriptId: relative, line: integer(bound.line) || point.line, column: 1 }] : []; }
      e.view.breakpoints = [...e.view.breakpoints.filter(p => p.path !== relative), ...points]; e.view.revision++;
    } finally { e.busy = false; }
  }
  async variables(project: string, task: string, id: string, reference: string): Promise<DebugValue[]> {
    const e = this.get(project, task, id); const target = e.objects.get(reference); const version = e.version;
    if (e.view.status !== 'paused' || !target) throw new AppError('bad_request');
    if (e.busy) throw new AppError('conflict'); e.busy = true;
    try {
      // LLDB reuses scope references between frames; select the owning frame before reading.
      await e.transport.request('scopes', { frameId: target.frame });
      if (version !== e.version || e.view.status !== 'paused') throw new AppError('conflict');
      const result = await e.transport.request('variables', { variablesReference: target.ref, start: 0, count: 256 });
      if (version !== e.version || e.view.status !== 'paused') throw new AppError('conflict');
      if (!Array.isArray(result.variables)) { this.end(e, 'malformed'); throw new AppError('unavailable', undefined, { field: 'variables' }); }
      return result.variables.slice(0, 256).map(value => this.value(e, object(value), target.frame));
    } finally { e.busy = false; }
  }
  private value(e: Entry, value: Record<string, unknown>, frame: number): DebugValue {
    const ref = integer(value.variablesReference); const key = `${frame}:${ref}`;
    if (ref && e.objects.size < 2048) e.objects.set(key, { ref, frame });
    return { name: text(value.name), type: text(value.type), value: text(value.value ?? value.result), ...(ref && e.objects.has(key) ? { objectId: key } : {}) };
  }
  async watch(project: string, task: string, id: string, frame: string, expression: string): Promise<DebugValue> {
    await this.options.beforeMutate?.(project, task); const e = this.get(project, task, id); const version = e.version;
    if (!e.view.capabilities.evaluate) throw new AppError('bad_request', undefined, { field: 'evaluate' });
    if (e.view.status !== 'paused' || !e.view.frames.some(f => f.id === frame) || typeof expression !== 'string' || !expression || expression.length > 512 || expression.includes('\0')) throw new AppError('bad_request');
    if (e.busy) throw new AppError('conflict'); e.busy = true;
    try {
      const result = await e.transport.request('evaluate', { frameId: Number(frame), expression, context: 'watch' });
      if (version !== e.version || e.view.status !== 'paused') throw new AppError('conflict');
      if (typeof result.result !== 'string') { this.end(e, 'malformed'); throw new AppError('unavailable', undefined, { field: 'evaluate' }); }
      return { ...this.value(e, result, Number(frame)), name: expression };
    } finally { e.busy = false; }
  }
  detach(project: string, task: string, id: string): void {
    const e = this.get(project, task, id); if (e.closed) return;
    void e.transport.request('disconnect', { terminateDebuggee: true }).catch(() => undefined).finally(() => this.end(e));
  }
  private end(e: Entry, reason?: DapSession['diagnostic']): void {
    if (e.closed) return; e.closed = true; clearTimeout(e.timer); e.version++; e.objects.clear(); e.view.frames = []; e.view.status = reason ? 'failed' : 'closed';
    if (reason) e.view.diagnostic = reason; e.initialized.reject(new AppError('unavailable')); e.transport.close();
  }
  close(): void { this.closed = true; for (const e of this.sessions.values()) this.end(e); }
}
