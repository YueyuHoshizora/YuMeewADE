import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';
import type { DebugAction, DebugBreakpoint, DebugFrame, DebugLocation, DebugSession, DebugValue } from '../shared/execution-tools.ts';
import type { ExecutionService } from './commands.ts';
import { loopbackUrl } from './integrations.ts';

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 8192) : '';
function location(value: unknown): DebugLocation { const v = record(value); return { scriptId: text(v.scriptId), line: typeof v.lineNumber === 'number' ? v.lineNumber + 1 : 1, column: typeof v.columnNumber === 'number' ? v.columnNumber + 1 : 1 }; }
interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
interface Entry { view: DebugSession; root: string; socket: WebSocket; next: number; pending: Map<number, Pending>; objects: Set<string>; breakpointPending: Set<string>; pauseVersion: number; closed: boolean }

/** Only attaches to inspectors started by this app; no arbitrary host, port, or remote evaluation endpoint. */
export class DebuggerService {
  private readonly execution: ExecutionService;
  private readonly sessions = new Map<string, Entry>();
  private readonly pendingRuns = new Set<string>();
  private closed = false;
  constructor(execution: ExecutionService) { this.execution = execution; }
  async attach(project: string, task: string, run: string): Promise<DebugSession> {
    if (this.closed) throw new AppError('unavailable');
    const existing = [...this.sessions.values()].find(e => e.view.project === project && e.view.task === task && e.view.run === run && !e.closed);
    if (existing) return this.snapshot(existing);
    if (this.pendingRuns.has(run)) throw new AppError('conflict');
    if (this.sessions.size + this.pendingRuns.size >= 64) {
      for (const [id, e] of this.sessions) if (e.closed) this.sessions.delete(id);
      if (this.sessions.size + this.pendingRuns.size >= 64) throw new AppError('unavailable');
    }
    this.pendingRuns.add(run);
    try {
      const root = this.execution.runDirectory(project, task, run);
      let target = this.execution.output(project, task, run);
      if (target.kind !== 'debug' || target.status !== 'running') throw new AppError('bad_request');
      for (let i = 0; i < 100 && !target.inspectorUrl; i++) { await delay(50); target = this.execution.output(project, task, run); if (target.status !== 'running' || this.closed) throw new AppError('conflict'); }
      if (!target.inspectorUrl) throw new AppError('unavailable');
      const url = loopbackUrl(target.inspectorUrl, true);
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'ws:' || !/^\/[a-f0-9-]+$/u.test(url.pathname) || url.search || url.hash) throw new AppError('bad_request');
      const socket = new WebSocket(url.href);
      const view: DebugSession = { id: randomUUID(), project, task, run, status: 'connecting', reason: '', frames: [], scripts: [], breakpoints: [] };
      const e: Entry = { view, root, socket, next: 0, pending: new Map(), objects: new Set(), breakpointPending: new Set(), pauseVersion: 0, closed: false };
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
      try { await this.rpc(e, 'Runtime.enable'); await this.rpc(e, 'Debugger.enable', { maxScriptsCacheSize: 1_048_576 }); view.status = 'running'; await this.rpc(e, 'Runtime.runIfWaitingForDebugger'); }
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
      if (!url.startsWith('file:') || !id || e.view.scripts.length >= 256) return;
      let file: string; try { file = fileURLToPath(url); } catch { return; }
      if (!(file === e.root || isInside(e.root, file))) return;
      e.view.scripts.push({ id, path: path.relative(e.root, file), url });
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
  state(project: string, task: string, id: string): DebugSession { return this.snapshot(this.get(project, task, id)); }
  async action(project: string, task: string, id: string, action: DebugAction): Promise<DebugSession> {
    const e = this.get(project, task, id);
    if (!['pause', 'resume', 'stepOver', 'stepInto', 'stepOut'].includes(action) || (action !== 'pause' && e.view.status !== 'paused') || (action === 'pause' && e.view.status !== 'running')) throw new AppError('bad_request');
    await this.rpc(e, `Debugger.${action}`); return this.snapshot(e);
  }
  async breakpoint(project: string, task: string, id: string, relative: string, line: number): Promise<DebugSession> {
    const e = this.get(project, task, id);
    if (typeof relative !== 'string' || relative.length > 4096 || path.isAbsolute(relative) || relative.includes('\0') || !Number.isSafeInteger(line) || line < 1 || line > 1_000_000 || e.view.breakpoints.length + e.breakpointPending.size >= 128) throw new AppError('bad_request');
    const reservation = JSON.stringify([relative, line]);
    if (e.breakpointPending.has(reservation)) throw new AppError('conflict');
    e.breakpointPending.add(reservation);
    try {
      const file = await fs.realpath(path.resolve(e.root, relative)).catch(() => null);
      if (!file || !isInside(e.root, file) || !(await fs.stat(file)).isFile()) throw new AppError('bad_request');
      const canonical = path.relative(e.root, file);
      if (e.view.breakpoints.some(b => b.path === canonical && b.line === line)) return this.snapshot(e);
      const result = await this.rpc(e, 'Debugger.setBreakpointByUrl', { url: pathToFileURL(file).href, lineNumber: line - 1 });
      const breakpoint: DebugBreakpoint = { id: text(result.breakpointId), path: canonical, line, locations: Array.isArray(result.locations) ? result.locations.slice(0, 64).map(location) : [] };
      if (!breakpoint.id) throw new AppError('unavailable');
      if (!e.view.breakpoints.some(b => b.id === breakpoint.id)) e.view.breakpoints.push(breakpoint);
      return this.snapshot(e);
    } finally { e.breakpointPending.delete(reservation); }
  }
  async removeBreakpoint(project: string, task: string, id: string, breakpoint: string): Promise<DebugSession> {
    const e = this.get(project, task, id); if (!e.view.breakpoints.some(b => b.id === breakpoint)) throw new AppError('not_found');
    await this.rpc(e, 'Debugger.removeBreakpoint', { breakpointId: breakpoint }); e.view.breakpoints = e.view.breakpoints.filter(b => b.id !== breakpoint); return this.snapshot(e);
  }
  async variables(project: string, task: string, id: string, object: string): Promise<DebugValue[]> {
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
  private disconnect(e: Entry, failed = false): void {
    if (e.closed) return; e.closed = true; e.view.status = failed ? 'failed' : 'closed'; e.view.frames = []; e.objects.clear();
    for (const pending of e.pending.values()) { clearTimeout(pending.timer); pending.reject(new AppError('unavailable')); } e.pending.clear();
    try { e.socket.close(); } catch { /* Already closed. */ }
  }
  detach(project: string, task: string, id: string): void { this.disconnect(this.get(project, task, id)); }
  close(): void { this.closed = true; for (const e of this.sessions.values()) this.disconnect(e); }
  async stopAll(): Promise<void> { this.close(); }
}
