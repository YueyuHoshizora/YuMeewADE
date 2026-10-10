import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { minimalEnv, signalTree } from '../cli/process.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';
import type { VerifyResult } from '../shared/types.ts';

interface VerifyOptions {
  ws: Workspace;
  projects: ProjectLedger;
  tasks: TaskLedger;
  config: Config;
  isRunning: (project: string, task: string) => boolean;
}

export class VerifyService {
  private readonly opts: VerifyOptions;
  private readonly runs = new Map<string, { stop?: (() => void) | undefined; done?: Promise<VerifyResult> }>();
  private closed = false;

  constructor(opts: VerifyOptions) { this.opts = opts; }

  run(project: string, task: string): Promise<VerifyResult> {
    const key = JSON.stringify([project, task]);
    if (this.closed || this.runs.has(key) || this.opts.isRunning(project, task) || this.runs.size >= this.opts.config.limits.concurrentRuns) throw new AppError('conflict');
    const entry: { stop?: (() => void) | undefined; done?: Promise<VerifyResult> } = {};
    // Reserve before reading the ledger so concurrent requests cannot both start.
    this.runs.set(key, entry);
    entry.done = this.execute(project, task, entry).finally(() => this.runs.delete(key));
    return entry.done;
  }

  private async execute(projectId: string, taskId: string, entry: { stop?: (() => void) | undefined }): Promise<VerifyResult> {
    const { ws, projects, tasks, config } = this.opts;
    const [project, task] = await Promise.all([projects.get(projectId), tasks.get(projectId, taskId)]);
    // Commands come exclusively from PROJECT.md, never from an HTTP request body.
    const command = project.verify.trim();
    if (!command || command.length > 500 || /[\r\n\0]/u.test(project.verify)) throw new AppError('bad_request');
    const cwd = await fs.realpath(task.workdir || projects.bodyPath(project)).catch(() => null);
    const [workspace, body] = await Promise.all([fs.realpath(ws.root), fs.realpath(projects.bodyPath(project)).catch(() => null)]);
    if (!cwd || !(await fs.stat(cwd).catch(() => null))?.isDirectory() || (!isInside(workspace, cwd) && !(body && (cwd === body || isInside(body, cwd))))) throw new AppError('bad_request');
    if (this.closed || this.opts.isRunning(projectId, taskId)) throw new AppError('conflict');
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
    timer = setTimeout(() => { timedOut = true; stop(); }, config.limits.verifySeconds * 1000);
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
