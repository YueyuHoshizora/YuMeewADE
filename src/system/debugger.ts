import { randomUUID, createHash } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../shared/errors.ts';
import { atomicWrite, withFileLocks } from '../shared/fsx.ts';
import { debugCondition, debugWatchPath } from '../shared/debug-expressions.ts';
import { debugFile, loadDebugSourceMap, originalLocation, generatedLocation } from './debug-source-maps.ts';
import type { DebugSourceMap } from './debug-source-maps.ts';
import type { DebugAction, DebugBreakpoint, DebugFrame, DebugLocation, DebugSession, DebugValue } from '../shared/execution-tools.ts';
import type { ExecutionService } from './commands.ts';
import { loopbackUrl } from './integrations.ts';
import { DapDebugger } from './dap-debugger.ts';
import type { DapLaunch, DapSession } from '../shared/dap.ts';

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 8192) : '';
function location(value: unknown): DebugLocation { const v = record(value); return { scriptId: text(v.scriptId), line: typeof v.lineNumber === 'number' ? v.lineNumber + 1 : 1, column: typeof v.columnNumber === 'number' ? v.columnNumber + 1 : 1 }; }
interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
interface Entry { view: DebugSession; root: string; socket: WebSocket; next: number; pending: Map<number, Pending>; objects: Set<string>; breakpointPending: Set<string>; pauseVersion: number; closed: boolean; maps: Map<string, DebugSourceMap>; loading: Promise<void>[]; metadata?: string }
export interface DebuggerOptions { metadataFile?: (project: string, task: string) => Promise<string>; beforeMutate?: (project: string, task: string) => Promise<void>; beforeLaunch?: (project: string, task: string) => Promise<void> }

/** Only attaches to inspectors started by this app; no arbitrary host, port, or remote evaluation endpoint. */
export class DebuggerService {
  private readonly execution: ExecutionService;
  private readonly sessions = new Map<string, Entry>();
  private readonly pendingRuns = new Set<string>();
  private closed = false;
  private readonly options: DebuggerOptions;
  private readonly dap: DapDebugger;
  constructor(execution: ExecutionService, options: DebuggerOptions = {}) { this.execution = execution; this.options = options; this.dap = new DapDebugger(execution, options); }
  launchDap(project: string, task: string, launch: DapLaunch): Promise<DapSession> { return this.dap.launch(project, task, launch); }
  isRunning(project: string, task?: string): boolean { return this.dap.isRunning(project, task); }
  isBusy(): boolean { return this.dap.isBusy() || this.pendingRuns.size > 0 || [...this.sessions.values()].some(e => !e.closed); }
  async attach(project: string, task: string, run: string): Promise<DebugSession> {
    if (this.closed) throw new AppError('unavailable');
    await this.options.beforeMutate?.(project, task);
    const existing = [...this.sessions.values()].find(e => e.view.project === project && e.view.task === task && e.view.run === run && !e.closed);
    if (existing) return this.snapshot(existing);
    if (this.pendingRuns.has(run)) throw new AppError('conflict');
    if (this.sessions.size + this.pendingRuns.size >= 64) {
      for (const [id, e] of this.sessions) if (e.closed) this.sessions.delete(id);
      if (this.sessions.size + this.pendingRuns.size >= 64) throw new AppError('unavailable');
    }
    this.pendingRuns.add(run);
    try {
      this.execution.runDirectory(project, task, run);
      const root = await this.execution.cwd(project, task);
      let target = this.execution.output(project, task, run);
      if (target.kind !== 'debug' || target.status !== 'running') throw new AppError('bad_request');
      for (let i = 0; i < 100 && !target.inspectorUrl; i++) { await delay(50); target = this.execution.output(project, task, run); if (target.status !== 'running' || this.closed) throw new AppError('conflict'); }
      if (!target.inspectorUrl) throw new AppError('unavailable');
      const url = loopbackUrl(target.inspectorUrl, true);
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'ws:' || !/^\/[a-f0-9-]+$/u.test(url.pathname) || url.search || url.hash) throw new AppError('bad_request');
      // Resolve filesystem metadata before opening the socket: open/error may arrive during any await.
      const metadata = await this.options.metadataFile?.(project, task);
      const socket = new WebSocket(url.href);
      const view: DebugSession = { id: randomUUID(), project, task, run, status: 'connecting', reason: '', frames: [], scripts: [], breakpoints: [], revision: 0 };
      const e: Entry = { view, root, socket, next: 0, pending: new Map(), objects: new Set(), breakpointPending: new Set(), pauseVersion: 0, closed: false, maps: new Map(), loading: [] };
      if (metadata) e.metadata = metadata;
      this.sessions.set(view.id, e);
      socket.addEventListener('message', event => { if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1_048_576) { this.disconnect(e, true); return; } this.receive(e, event.data); });
      socket.addEventListener('close', () => this.disconnect(e));
      socket.addEventListener('error', () => this.disconnect(e, true));
      const openedGate = Promise.withResolvers<void>();
      const timer = setTimeout(() => { this.disconnect(e, true); openedGate.reject(new AppError('unavailable')); }, 5000);
      const opened = () => { clearTimeout(timer); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed); openedGate.resolve(); };
      const failed = () => { clearTimeout(timer); socket.removeEventListener('open', opened); openedGate.reject(new AppError('unavailable')); };
      socket.addEventListener('open', opened, { once: true }); socket.addEventListener('error', failed, { once: true }); socket.addEventListener('close', failed, { once: true });
      await openedGate.promise;
      try {
        await this.rpc(e, 'Runtime.enable'); await this.rpc(e, 'Debugger.enable', { maxScriptsCacheSize: 1_048_576 });
        await Promise.all(e.loading);
        if (e.metadata) for (const point of await this.readMetadata(e)) await this.breakpoint(project, task, view.id, point.path, point.line, point.condition, false);
        view.status = 'running'; await this.rpc(e, 'Runtime.runIfWaitingForDebugger');
      }
      catch (error) { this.disconnect(e, true); throw error; }
      return this.snapshot(e);
    } finally { this.pendingRuns.delete(run); }
  }
  private rpc(e: Entry, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (e.closed || e.socket.readyState !== WebSocket.OPEN) return Promise.reject(new AppError('conflict'));
    if (e.pending.size >= 32) return Promise.reject(new AppError('unavailable'));
    const id = ++e.next;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => { e.pending.delete(id); reject(new AppError('unavailable')); }, 5000);
    e.pending.set(id, { resolve, reject, timer });
    try { e.socket.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); e.pending.delete(id); reject(new AppError('unavailable')); }
    return promise;
  }
  private receive(e: Entry, data: string): void {
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(data)); } catch { this.disconnect(e, true); return; }
    if (typeof message.id === 'number') {
      const pending = e.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); e.pending.delete(message.id);
      if (message.error) pending.reject(new AppError('bad_request')); else pending.resolve(record(message.result));
      return;
    }
    const params = record(message.params);
    if (message.method === 'Debugger.scriptParsed') {
      const url = text(params.url); const id = text(params.scriptId);
      if (!url.startsWith('file:') || !id || e.view.scripts.length + e.loading.length >= 256) return;
      let file: string; try { file = fileURLToPath(url); } catch { return; }
      const relative = path.relative(e.root, file).split(path.sep).join('/');
      const loading = (async () => {
        try {
          await debugFile(e.root, relative);
          if (e.closed || e.view.scripts.some(s => s.id === id)) return;
          const script = { id, path: relative, url, sources: [] as string[] }; e.view.scripts.push(script);
          const map = e.maps.size < 16 ? await loadDebugSourceMap(e.root, file, typeof params.sourceMapURL === 'string' ? params.sourceMapURL : '') : undefined;
          const totalSegments = [...e.maps.values()].reduce((sum, item) => sum + item.segments.length + item.unmapped.length, 0);
          if (map && !e.closed && e.maps.size < 16 && totalSegments + map.segments.length + map.unmapped.length <= 131072) {
            e.maps.set(id, map); script.sources = map.sources; this.mapFrames(e);
            for (const point of e.view.breakpoints) {
              const mapped = generatedLocation(map, point.path, point.line); if (!mapped) continue;
              const rebound: Record<string, unknown> = await this.rpc(e, 'Debugger.setBreakpointByUrl', { url, lineNumber: mapped.generatedLine - 1, columnNumber: mapped.generatedColumn - 1, condition: point.condition ?? '' }).catch(() => { this.disconnect(e, true); return {}; });
              if (typeof rebound.breakpointId === 'string' && rebound.breakpointId !== point.id) {
                await this.rpc(e, 'Debugger.removeBreakpoint', { breakpointId: point.id }).catch(() => { this.disconnect(e, true); });
                point.id = rebound.breakpointId; point.locations = Array.isArray(rebound.locations) ? rebound.locations.slice(0, 64).map(location) : [];
              }
            }
          }
        } catch { /* Unsafe or unreadable script paths never enter the public view. */ }
      })();
      e.loading.push(loading); void loading.finally(() => { e.loading = e.loading.filter(item => item !== loading); });
    } else if (message.method === 'Debugger.paused') {
      e.view.status = 'paused'; e.view.reason = text(params.reason); e.objects.clear();
      e.pauseVersion++;
      const frames: DebugFrame[] = [];
      if (Array.isArray(params.callFrames)) for (const value of params.callFrames.slice(0, 64)) {
        const frame = record(value); const scopes: DebugFrame['scopes'] = [];
        if (Array.isArray(frame.scopeChain)) for (const item of frame.scopeChain.slice(0, 16)) {
          const scope = record(item); const object = record(scope.object); const id = text(object.objectId);
          if (id) e.objects.add(id);
          scopes.push({ name: text(scope.name), type: text(scope.type), ...(id ? { objectId: id } : {}) });
        }
        frames.push({ id: text(frame.callFrameId), name: text(frame.functionName), url: text(frame.url), location: location(frame.location), scopes });
      }
      e.view.frames = frames;
      this.mapFrames(e);
    } else if (message.method === 'Debugger.resumed') { e.view.status = 'running'; e.view.frames = []; e.objects.clear(); }
    else if (message.method === 'Debugger.breakpointResolved') {
      const breakpoint = e.view.breakpoints.find(b => b.id === params.breakpointId);
      if (breakpoint && breakpoint.locations.length < 64) breakpoint.locations.push(location(params.location));
    }
  }
  private get(project: string, task: string, id: string): Entry {
    const e = this.sessions.get(id); if (!e || e.view.project !== project || e.view.task !== task) throw new AppError('not_found');
    if (e.view.status !== 'closed' && this.execution.output(project, task, e.view.run).status !== 'running') {
      // Process termination can emit a WebSocket error before the close event. The owned run is authoritative.
      this.disconnect(e);
      e.view.status = 'closed';
    }
    return e;
  }
  private snapshot(e: Entry): DebugSession { return structuredClone(e.view); }
  state(project: string, task: string, id: string): DebugSession { return this.dap.has(id) ? this.dap.state(project, task, id) : this.snapshot(this.get(project, task, id)); }
  async action(project: string, task: string, id: string, action: DebugAction): Promise<DebugSession> {
    if (this.dap.has(id)) return this.dap.action(project, task, id, action);
    await this.options.beforeMutate?.(project, task);
    const current = this.get(project, task, id); await Promise.all(current.loading);
    const e = this.get(project, task, id);
    if (!['pause', 'resume', 'stepOver', 'stepInto', 'stepOut'].includes(action) || (action !== 'pause' && e.view.status !== 'paused') || (action === 'pause' && e.view.status !== 'running')) throw new AppError('bad_request');
    await this.rpc(e, `Debugger.${action}`); return this.snapshot(e);
  }
  async breakpoint(project: string, task: string, id: string, relative: string, line: number, expression?: string, persist = true, revision?: number): Promise<DebugSession> {
    if (this.dap.has(id)) return this.dap.breakpoint(project, task, id, relative, line, expression, revision);
    await this.options.beforeMutate?.(project, task);
    const e = this.get(project, task, id); const condition = debugCondition(expression);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision !== e.view.revision)) throw new AppError('conflict');
    if (!Number.isSafeInteger(line) || line < 1 || line > 1_000_000 || e.view.breakpoints.length + e.breakpointPending.size >= 128) throw new AppError('bad_request');
    const reservation = JSON.stringify([relative, line]);
    if (e.breakpointPending.size) throw new AppError('conflict');
    e.breakpointPending.add(reservation);
    try {
      const file = await debugFile(e.root, relative);
      if (!(await fs.stat(file)).isFile()) throw new AppError('bad_request');
      const canonical = path.relative(e.root, file).split(path.sep).join('/');
      if (e.view.breakpoints.some(b => b.path === canonical && b.line === line)) return this.snapshot(e);
      await Promise.all(e.loading);
      let targetFile = file; let targetLine = line; let targetColumn = 1;
      for (const [scriptId, map] of e.maps) {
        const mapped = generatedLocation(map, canonical, line);
        const script = e.view.scripts.find(s => s.id === scriptId);
        if (mapped && script) { targetFile = path.resolve(e.root, script.path); targetLine = mapped.generatedLine; targetColumn = mapped.generatedColumn; break; }
      }
      const result = await this.rpc(e, 'Debugger.setBreakpointByUrl', { url: pathToFileURL(targetFile).href, lineNumber: targetLine - 1, columnNumber: targetColumn - 1, condition });
      const breakpoint: DebugBreakpoint = { id: text(result.breakpointId), path: canonical, line, ...(condition ? { condition } : {}), locations: Array.isArray(result.locations) ? result.locations.slice(0, 64).map(location) : [] };
      if (!breakpoint.id) throw new AppError('unavailable');
      if (!e.view.breakpoints.some(b => b.id === breakpoint.id)) e.view.breakpoints.push(breakpoint);
      e.view.revision++;
      if (persist) await this.persist(e);
      return this.snapshot(e);
    } finally { e.breakpointPending.delete(reservation); }
  }
  async removeBreakpoint(project: string, task: string, id: string, breakpoint: string, revision?: number): Promise<DebugSession> {
    if (this.dap.has(id)) return this.dap.removeBreakpoint(project, task, id, breakpoint, revision);
    await this.options.beforeMutate?.(project, task);
    const e = this.get(project, task, id);
    await Promise.all(e.loading);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision !== e.view.revision)) throw new AppError('conflict');
    if (e.breakpointPending.size) throw new AppError('conflict');
    if (!e.view.breakpoints.some(b => b.id === breakpoint)) throw new AppError('not_found');
    e.breakpointPending.add(breakpoint);
    try {
      await this.rpc(e, 'Debugger.removeBreakpoint', { breakpointId: breakpoint }); e.view.breakpoints = e.view.breakpoints.filter(b => b.id !== breakpoint); e.view.revision++;
      await this.persist(e); return this.snapshot(e);
    } finally { e.breakpointPending.delete(breakpoint); }
  }
  async variables(project: string, task: string, id: string, object: string): Promise<DebugValue[]> {
    if (this.dap.has(id)) return this.dap.variables(project, task, id, object);
    const e = this.get(project, task, id); if (e.view.status !== 'paused' || !e.objects.has(object)) throw new AppError('bad_request');
    const version = e.pauseVersion;
    const result = await this.rpc(e, 'Runtime.getProperties', { objectId: object, ownProperties: true, generatePreview: false });
    if (e.view.status !== 'paused' || version !== e.pauseVersion || !e.objects.has(object)) throw new AppError('conflict');
    if (!Array.isArray(result.result)) throw new AppError('unavailable');
    return result.result.slice(0, 256).map(value => {
      const property = record(value); const v = record(property.value); const objectId = text(v.objectId);
      if (objectId && e.objects.size < 2048) e.objects.add(objectId);
      const rendered = typeof v.value === 'string' ? v.value : v.value !== undefined ? JSON.stringify(v.value) ?? '' : text(v.unserializableValue) || text(v.description);
      return { name: text(property.name), type: text(v.type), value: rendered.slice(0, 8192), ...(objectId && e.objects.has(objectId) ? { objectId } : {}) };
    });
  }
  private mapFrames(e: Entry): void {
    for (const frame of e.view.frames) {
      const map = e.maps.get(frame.location.scriptId);
      const mapped = map && originalLocation(map, frame.location.line, frame.location.column);
      if (mapped) frame.location.source = { path: mapped.path, line: mapped.line, column: mapped.column };
    }
  }
  private async readMetadata(e: Entry): Promise<{ path: string; line: number; condition?: string }[]> {
    if (!e.metadata) return [];
    const stat = await fs.lstat(e.metadata).catch(() => null);
    if (!stat) return [];
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 131072) throw new AppError('bad_request');
    const handle = await fs.open(e.metadata, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: { root?: string; breakpoints?: unknown };
    try {
      const openedStat = await handle.stat(); if (!openedStat.isFile() || openedStat.size > 131072) throw new AppError('bad_request');
      const bytes = Buffer.alloc(131073); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 131072) throw new AppError('bad_request');
      data = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as typeof data;
    } finally { await handle.close(); }
    if (data.root !== createHash('sha256').update(e.root).digest('hex')) return [];
    if (!Array.isArray(data.breakpoints) || data.breakpoints.length > 128) throw new AppError('bad_request');
    const result: { path: string; line: number; condition?: string }[] = [];
    for (const value of data.breakpoints) {
      const point = record(value);
      if (typeof point.path !== 'string' || !Number.isSafeInteger(point.line) || (point.line as number) < 1 || (point.line as number) > 1000000) throw new AppError('bad_request');
      const condition = debugCondition(point.condition);
      await debugFile(e.root, point.path);
      result.push({ path: point.path, line: point.line as number, ...(condition ? { condition } : {}) });
    }
    return result;
  }
  private async persist(e: Entry): Promise<void> {
    if (!e.metadata) return;
    await withFileLocks([e.metadata], async () => {
      const stat = await fs.lstat(e.metadata!).catch(() => null);
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new AppError('bad_request');
      const serialized = JSON.stringify({ root: createHash('sha256').update(e.root).digest('hex'), breakpoints: e.view.breakpoints.map(({ path, line, condition }) => ({ path, line, ...(condition ? { condition } : {}) })) }) + '\n';
      if (Buffer.byteLength(serialized) > 131072) throw new AppError('bad_request');
      await atomicWrite(e.metadata!, serialized);
      await fs.chmod(e.metadata!, 0o600);
    });
  }
  async watch(project: string, task: string, id: string, frameId: string, expression: string): Promise<DebugValue> {
    if (this.dap.has(id)) return this.dap.watch(project, task, id, frameId, expression);
    const parts = debugWatchPath(expression); const e = this.get(project, task, id);
    const frame = e.view.frames.find(f => f.id === frameId);
    if (e.view.status !== 'paused' || !frame) throw new AppError('bad_request');
    let value: DebugValue | undefined;
    for (const scope of frame.scopes) {
      if (!scope.objectId) continue;
      value = (await this.variables(project, task, id, scope.objectId)).find(v => v.name === parts[0] && v.type);
      if (value) break;
    }
    for (const part of parts.slice(1)) {
      if (!value?.objectId) throw new AppError('not_found');
      value = (await this.variables(project, task, id, value.objectId)).find(v => v.name === part && v.type);
    }
    if (!value) throw new AppError('not_found');
    return { ...value, name: expression };
  }
  private disconnect(e: Entry, failed = false): void {
    if (e.closed) return; e.closed = true; e.view.status = failed ? 'failed' : 'closed'; e.view.frames = []; e.objects.clear();
    for (const pending of e.pending.values()) { clearTimeout(pending.timer); pending.reject(new AppError('unavailable')); } e.pending.clear();
    try { e.socket.close(); } catch { /* Already closed. */ }
  }
  detach(project: string, task: string, id: string): void { if (this.dap.has(id)) this.dap.detach(project, task, id); else this.disconnect(this.get(project, task, id)); }
  close(): void { this.closed = true; this.dap.close(); for (const e of this.sessions.values()) this.disconnect(e); }
  async stopAll(): Promise<void> { this.close(); }
}
