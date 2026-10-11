import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { minimalEnv, signalTree } from '../cli/process.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';
import type { VerifyResult, VerifyStatus } from '../shared/types.ts';
import { verificationFingerprint } from './verification-fingerprint.ts';
import { parseVerificationChecks } from '../shared/verification.ts';

interface VerifyOptions {
  ws: Workspace;
  projects: ProjectLedger;
  tasks: TaskLedger;
  config: Config;
  isRunning: (project: string, task: string) => boolean;
  beforeRun?: (project: string) => Promise<void>;
}

export class VerifyService {
  private readonly opts: VerifyOptions;
  private readonly runs = new Map<string, { stop?: (() => void) | undefined; done?: Promise<VerifyResult> }>();
  private readonly last = new Map<string, { status: VerifyStatus; fingerprint: string }>();
  private closed = false;

  constructor(opts: VerifyOptions) { this.opts = opts; }

  /** 狀態讀取重新計算實際內容；外部編輯與設定變更不依賴 UI invalidate。 */
  async status(project: string, task: string): Promise<VerifyStatus | null> {
    const key = JSON.stringify([project, task]);
    const cached = this.last.get(key);
    if (!cached || this.runs.has(key) || this.opts.isRunning(project, task)) return null;
    try {
      const context = await this.context(project, task);
      const fingerprint = await verificationFingerprint(context.cwd, context.configuration);
      const current = await this.context(project, task);
      if (cached.fingerprint === fingerprint && current.cwd === context.cwd && current.configuration === context.configuration && this.last.get(key) === cached && !this.runs.has(key) && !this.opts.isRunning(project, task)) return cached.status;
    } catch { /* 無法可靠讀取輸入即失效，不能沿用綠燈。 */ }
    this.last.delete(key);
    return null;
  }

  isBusy(): boolean { return this.runs.size > 0; }
  isRunning(project: string, task?: string): boolean {
    if (task !== undefined) return this.runs.has(JSON.stringify([project, task]));
    return [...this.runs.keys()].some(key => (JSON.parse(key) as string[])[0] === project);
  }

  async requireCurrentPass(project: string, task: string): Promise<void> {
    if (!(await this.opts.projects.get(project)).requireVerification) return;
    if (!(await this.status(project, task))?.ok) throw new AppError('conflict', 'verification_required');
  }

  invalidate(project: string, task: string): void {
    this.last.delete(JSON.stringify([project, task]));
  }

  run(project: string, task: string): Promise<VerifyResult> {
    const key = JSON.stringify([project, task]);
    if (this.closed || this.runs.has(key) || this.opts.isRunning(project, task) || this.runs.size >= this.opts.config.limits.concurrentRuns) throw new AppError('conflict');
    const entry: { stop?: (() => void) | undefined; done?: Promise<VerifyResult> } = {};
    // Reserve before reading the ledger so concurrent requests cannot both start.
    this.runs.set(key, entry);
    this.last.delete(key);
    entry.done = this.execute(project, task, entry).finally(() => this.runs.delete(key));
    return entry.done;
  }

  private async context(projectId: string, taskId: string) {
    const { ws, projects, tasks } = this.opts;
    const [project, task] = await Promise.all([projects.get(projectId), tasks.get(projectId, taskId)]);
    const checks = parseVerificationChecks(project.checks?.length ? project.checks : project.verify.trim() ? [{ name: 'verify', command: project.verify }] : []);
    if (!checks.length) throw new AppError('bad_request');
    const cwd = await fs.realpath(task.workdir || projects.bodyPath(project)).catch(() => null);
    const [workspace, body] = await Promise.all([fs.realpath(ws.root), fs.realpath(projects.bodyPath(project)).catch(() => null)]);
    if (!cwd || !(await fs.stat(cwd).catch(() => null))?.isDirectory() || (!isInside(workspace, cwd) && !(body && (cwd === body || isInside(body, cwd))))) throw new AppError('bad_request');
    return { cwd, checks, configuration: JSON.stringify([project.verify, checks, project.requireVerification]) };
  }

  private async execute(projectId: string, taskId: string, entry: { stop?: (() => void) | undefined }): Promise<VerifyResult> {
    const key = JSON.stringify([projectId, taskId]);
    await this.opts.beforeRun?.(projectId);
    const context = await this.context(projectId, taskId);
    let drifted = false;
    const started = Date.now();
    const deadline = started + this.opts.config.limits.verifySeconds * 1000;
    try {
      const before = await verificationFingerprint(context.cwd, context.configuration);
      if (this.closed || this.opts.isRunning(projectId, taskId)) throw new AppError('conflict');
      const steps = [];
      for (const check of context.checks) {
        if (this.closed || Date.now() >= deadline) break;
        const result = await this.executeCommand(context.cwd, check.command, entry, Math.max(1, deadline - Date.now()));
        steps.push({ name: check.name, command: check.command, ...result });
        if (result.timedOut || this.closed) break;
      }
      const current = await this.context(projectId, taskId);
      const after = await verificationFingerprint(current.cwd, current.configuration).catch(() => null);
      drifted ||= before !== after;
      const failed = steps.find(step => !step.ok);
      const output = steps.length === 1 ? steps[0]!.output : steps.map(step => `[${step.name}] ${step.ok ? 'PASS' : 'FAIL'}\\n${step.output}`).join('\\n');
      const limit = this.opts.config.limits.verifyOutputBytes;
      const bytes = Buffer.from(output);
      const tail = bytes.subarray(Math.max(0, bytes.length - limit));
      let start = 0;
      while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
      const result: VerifyResult = {
        ok: steps.length === context.checks.length && !failed && !drifted && !this.closed,
        exitCode: failed ? failed.exitCode : steps.length === context.checks.length ? 0 : null,
        timedOut: steps.some(step => step.timedOut) || (steps.length < context.checks.length && !this.closed),
        ms: Date.now() - started, output: tail.subarray(start).toString('utf8'),
        truncated: bytes.length > limit || steps.some(step => step.truncated), steps, drifted,
      };
      if (!drifted && after) this.last.set(key, { fingerprint: after, status: { ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, at: new Date().toISOString(), steps, drifted } });
      return result;
    } finally { entry.stop = undefined; }
  }

  private async executeCommand(cwd: string, command: string, entry: { stop?: (() => void) | undefined }, timeoutMs: number): Promise<VerifyResult> {
    const { config } = this.opts;
    const started = Date.now();
    const env = minimalEnv(config.cli.envPassthrough);
    const tail = Buffer.alloc(config.limits.verifyOutputBytes);
    let position = 0;
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let bound: NodeJS.Timeout | undefined;
    const { promise, resolve } = Promise.withResolvers<VerifyResult>();
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(bound);
      const bytes = size < tail.length ? tail.subarray(0, size) : Buffer.concat([tail.subarray(position), tail.subarray(0, position)], size);
      // A byte-tail may begin inside a UTF-8 character; omit those partial bytes.
      let start = 0;
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      resolve({ ok: exitCode === 0 && !timedOut && !stopped, exitCode, timedOut, ms: Date.now() - started, output: bytes.subarray(start).toString('utf8'), truncated });
    };
    // cmd /s removes the outer quotes; preserve quoted executable paths inside.
    const child = spawn(process.platform === 'win32' ? env['ComSpec'] || 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', ...(process.platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
    });
    const capture = (chunk: Buffer) => {
      if (settled) return;
      if (size + chunk.length > tail.length) truncated = true;
      if (chunk.length >= tail.length) {
        chunk.copy(tail, 0, chunk.length - tail.length);
        position = 0; size = tail.length;
      } else {
        const first = Math.min(chunk.length, tail.length - position);
        chunk.copy(tail, position, 0, first);
        chunk.copy(tail, 0, first);
        position = (position + chunk.length) % tail.length;
        size = Math.min(tail.length, size + chunk.length);
      }
    };
    const stop = () => {
      if (settled || stopped) return;
      stopped = true;
      signalTree(child, 'SIGKILL');
      bound = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null);
      }, 1000);
    };
    entry.stop = stop;
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', () => finish(null));
    child.on('close', code => finish(code));
    return promise;
  }

  close(): void {
    this.closed = true;
    for (const run of this.runs.values()) run.stop?.();
  }

  async stopAll(): Promise<void> {
    this.close();
    await Promise.allSettled([...this.runs.values()].flatMap(run => run.done ? [run.done] : []));
  }
}
