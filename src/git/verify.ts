import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { minimalEnv, signalTree, spawnCli } from '../cli/process.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { atomicWrite, isInside, withFileLocks } from '../shared/fsx.ts';
import type { VerificationHistoryEntry } from '../shared/test-explorer.ts';
import type { VerifyResult, VerifyStatus } from '../shared/types.ts';
import { verificationFingerprint } from './verification-fingerprint.ts';
import { parseVerificationChecks, parseVerificationInputModel } from '../shared/verification.ts';

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
  private readonly invalidated = new Set<string>();
  private readonly revocations = new Set<Promise<void>>();
  private closed = false;

  constructor(opts: VerifyOptions) { this.opts = opts; }

  private async historyFile(project: string, task: string): Promise<string> {
    this.opts.ws.taskFile(project, task);
    await this.opts.tasks.get(project, task);
    const root = await fs.realpath(this.opts.ws.projectDir(project));
    const folder = path.join(root, '.ai', 'verification');
    await fs.mkdir(folder, { recursive: true });
    if (!isInside(root, await fs.realpath(folder))) throw new AppError('bad_request');
    const file = path.join(folder, `${task}.json`);
    const stat = await fs.lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new AppError('bad_request');
    return file;
  }

  async history(project: string, task: string): Promise<VerificationHistoryEntry[]> {
    const file = await this.historyFile(project, task);
    const stat = await fs.stat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!stat) return [];
    if (stat.size > 4 * 1024 * 1024) throw new AppError('bad_request');
    const rows: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(rows) || rows.length > 20 || rows.some(row => !row || typeof row.id !== 'string' || typeof row.before !== 'string' || typeof row.configuration !== 'string' || typeof row.status?.ok !== 'boolean' || typeof row.result?.output !== 'string')) throw new AppError('bad_request');
    return rows as VerificationHistoryEntry[];
  }

  private async record(project: string, task: string, row: VerificationHistoryEntry): Promise<void> {
    const file = await this.historyFile(project, task);
    const steps = row.result.steps?.map(step => ({ ...step, output: step.output.slice(-16384), truncated: step.truncated || step.output.length > 16384 }));
    row = { ...row, result: { ...row.result, output: row.result.output.slice(-65536), truncated: row.result.truncated || row.result.output.length > 65536, ...(steps ? { steps } : {}) }, status: { ...row.status, ...(steps ? { steps } : {}) } };
    await withFileLocks([this.opts.ws.projectFile(project), file], async () => {
      await this.opts.tasks.get(project, task);
      const rows = [...await this.history(project, task), row].slice(-20);
      while (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024 && rows.length > 1) rows.shift();
      if (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) throw new AppError('too_large');
      await atomicWrite(file, JSON.stringify(rows) + '\n');
      await fs.chmod(file, 0o600);
    });
  }

  /** 狀態讀取重新計算實際內容；外部編輯與設定變更不依賴 UI invalidate。 */
  async status(project: string, task: string): Promise<VerifyStatus | null> {
    const key = JSON.stringify([project, task]);
    let cached = this.last.get(key);
    if (!cached && !this.invalidated.has(key)) {
      const row = (await this.history(project, task).catch(() => [])).at(-1);
      if (row?.after && row.before === row.after && !row.result.drifted && !row.revoked) cached = { fingerprint: row.after, status: row.status };
      if (cached) this.last.set(key, cached);
    }
    if (!cached || this.runs.has(key) || this.opts.isRunning(project, task)) return null;
    try {
      const context = await this.context(project, task);
      const fingerprint = await verificationFingerprint(context.cwd, context.configuration, context.model);
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
    this.invalidated.add(JSON.stringify([project, task]));
    const pending = this.historyFile(project, task).then(file => withFileLocks([file], async () => {
      const rows = await this.history(project, task);
      for (const row of rows) row.revoked = true;
      await atomicWrite(file, JSON.stringify(rows) + '\n');
      await fs.chmod(file, 0o600);
    }));
    this.revocations.add(pending);
    void pending.finally(() => this.revocations.delete(pending)).catch(() => {});
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

  /** Explicit Node argv runs share process limits/trust but never satisfy the full-check gate. */
  runNodeTests(project: string, task: string, files: string[], pattern?: string): Promise<VerifyResult> {
    const key = JSON.stringify([project, task]);
    if (this.closed || this.runs.has(key) || this.opts.isRunning(project, task) || this.runs.size >= this.opts.config.limits.concurrentRuns) throw new AppError('conflict');
    const entry: { stop?: (() => void) | undefined; done?: Promise<VerifyResult> } = {};
    this.runs.set(key, entry);
    entry.done = (async () => {
      await this.opts.beforeRun?.(project);
      const { cwd } = await this.context(project, task, false);
      if (!Array.isArray(files) || !files.length || files.length > 100 || files.some(file => typeof file !== 'string' || !file.startsWith('./') || file.length > 4096 || /[\0\r\n]/u.test(file)) || (pattern !== undefined && (typeof pattern !== 'string' || pattern.length > 12000))) throw new AppError('bad_request');
      for (const file of files) {
        const real = await fs.realpath(path.resolve(cwd, file));
        if (!isInside(cwd, real) || !(await fs.stat(real)).isFile()) throw new AppError('bad_request');
      }
      if (this.closed || this.opts.isRunning(project, task)) throw new AppError('conflict');
      const args = ['--test', '--test-reporter=tap', ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files];
      return this.executeCommand(cwd, process.execPath, entry, this.opts.config.limits.verifySeconds * 1000, args);
    })().finally(() => this.runs.delete(key));
    return entry.done;
  }

  private async context(projectId: string, taskId: string, requireChecks = true) {
    const { ws, projects, tasks } = this.opts;
    const [project, task] = await Promise.all([projects.get(projectId), tasks.get(projectId, taskId)]);
    const checks = parseVerificationChecks(project.checks?.length ? project.checks : project.verify.trim() ? [{ name: 'verify', command: project.verify }] : []);
    if (requireChecks && !checks.length) throw new AppError('bad_request');
    const cwd = await fs.realpath(task.workdir || projects.bodyPath(project)).catch(() => null);
    const [workspace, body] = await Promise.all([fs.realpath(ws.root), fs.realpath(projects.bodyPath(project)).catch(() => null)]);
    if (!cwd || !(await fs.stat(cwd).catch(() => null))?.isDirectory() || (!isInside(workspace, cwd) && !(body && (cwd === body || isInside(body, cwd))))) throw new AppError('bad_request');
    const model = parseVerificationInputModel(project.verificationInputs);
    return { cwd, checks, model, configuration: JSON.stringify([project.verify, checks, project.requireVerification, model]) };
  }

  private async execute(projectId: string, taskId: string, entry: { stop?: (() => void) | undefined }): Promise<VerifyResult> {
    const key = JSON.stringify([projectId, taskId]);
    await Promise.all(this.revocations);
    await this.opts.beforeRun?.(projectId);
    const context = await this.context(projectId, taskId);
    await this.historyFile(projectId, taskId);
    let drifted = false;
    const started = Date.now();
    const deadline = started + this.opts.config.limits.verifySeconds * 1000;
    try {
      const before = await verificationFingerprint(context.cwd, context.configuration, context.model);
      if (this.closed || this.opts.isRunning(projectId, taskId)) throw new AppError('conflict');
      const steps = [];
      for (const check of context.checks) {
        if (this.closed || Date.now() >= deadline) break;
        const result = await this.executeCommand(context.cwd, check.command, entry, Math.max(1, deadline - Date.now()));
        steps.push({ name: check.name, command: check.command, ...result });
        if (result.timedOut || this.closed) break;
      }
      const current = await this.context(projectId, taskId);
      const after = await verificationFingerprint(current.cwd, current.configuration, current.model).catch(() => null);
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
      const status: VerifyStatus = { ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, at: new Date().toISOString(), steps, drifted };
      await this.record(projectId, taskId, { id: randomUUID(), at: status.at, before, after, configuration: context.configuration, result, status });
      this.invalidated.delete(key);
      if (!drifted && after) this.last.set(key, { fingerprint: after, status });
      return result;
    } finally { entry.stop = undefined; }
  }

  private async executeCommand(cwd: string, command: string, entry: { stop?: (() => void) | undefined }, timeoutMs: number, args?: string[]): Promise<VerifyResult> {
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
    const child = spawnCli(args ? command : process.platform === 'win32' ? env['ComSpec'] || 'cmd.exe' : 'sh', args ?? (process.platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command]), {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', ...(!args && process.platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
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
        child.stdout!.destroy(); child.stderr!.destroy(); child.unref(); finish(null);
      }, 1000);
    };
    entry.stop = stop;
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout!.on('data', capture);
    child.stderr!.on('data', capture);
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
    await Promise.all(this.revocations);
  }
}
