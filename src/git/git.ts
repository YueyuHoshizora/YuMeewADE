// git 指令包裝：唯一呼叫 git 的地方。環境最小化、不提示輸入、身分缺省時用 YuMeewADE。

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { minimalEnv, terminateTree } from '../cli/process.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

const ENV = minimalEnv([]);
const IDENTITY = ['-c', 'user.name=YuMeewADE', '-c', 'user.email=yumeewade@localhost'];


/** Normal local operations must finish within two minutes; tests may use a shorter deadline. */
export const GIT_TIMEOUT_MS = 120_000;
export function git(cwd: string, args: string[], opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<GitResult> {
  const { promise, resolve, reject } = Promise.withResolvers<GitResult>();
  const child = spawn('git', [...IDENTITY, ...args], { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const max = opts.maxBytes ?? 10_000_000;
  const decoder = new StringDecoder('utf8');
  let stdout = '';
  let bytes = 0;
  let truncated = false;
  let stderr = '';
  let timedOut = false;
  let stop: (() => void) | undefined;
  const finish = (code: number) => {
    clearTimeout(deadline);
    stop?.();
    resolve({ code: timedOut ? -1 : code, stdout: stdout + (truncated ? '' : decoder.end()), stderr: timedOut ? 'git operation timed out' : stderr, truncated });
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop = terminateTree(child, () => finish(-1));
  }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, max - bytes);
    if (chunk.length > remaining) truncated = true;
    if (remaining > 0) stdout += decoder.write(chunk.subarray(0, remaining));
    bytes += Math.min(chunk.length, remaining);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    if (stderr.length < 4000) stderr += c;
  });
  child.on('error', (cause) => {
    clearTimeout(deadline);
    stop?.();
    reject(new AppError('internal', 'git_failed', { cause }));
  });
  child.on('close', (code) => finish(code ?? -1));
  return promise;
}

/** 失敗就丟 500（原因進日誌）；成功回 stdout。 */
export async function gitOk(cwd: string, args: string[], opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0 || r.truncated) {
    log.error('git 失敗', undefined, { cwd, args, code: r.code, stderr: r.stderr.slice(0, 500) });
    throw new AppError('internal', 'git_failed', { cause: new Error(r.stderr.slice(0, 500)) });
  }
  return r.stdout;
}

export async function isRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (r.code < 0 || r.truncated) throw new AppError('internal', 'git_failed');
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function hasCommits(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (result.code < 0 || result.truncated) throw new AppError('internal', 'git_failed');
  return result.code === 0;
}

/** 把工作樹全部提交；沒有變更回 false。 */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await gitOk(dir, ['add', '-A']);
  // Only newly staged secrets are excluded; previously tracked configuration keeps its normal history.
  const added = (await gitOk(dir, ['diff', '--cached', '--name-only', '--diff-filter=A', '-z'])).split('\0').filter(Boolean);
  const secrets = added.filter(isLocalSecret);
  if (secrets.length > 0) {
    if (await hasCommits(dir)) await gitOk(dir, ['reset', '-q', 'HEAD', '--', ...secrets]);
    else await gitOk(dir, ['rm', '-q', '--cached', '--', ...secrets]);
  }
  const staged = await git(dir, ['diff', '--cached', '--quiet']);
  if (staged.code !== 0 && staged.code !== 1) throw new AppError('internal', 'git_failed');
  if (staged.code === 0 && (await hasCommits(dir))) return false;
  await gitOk(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message]);
  return true;
}

/** 沒有 git 就 init（main 分支）並做第一次提交；已有但無提交也補一次。 */
export async function ensureRepo(dir: string): Promise<void> {
  if (!(await isRepo(dir))) await gitOk(dir, ['init', '-q', '-b', 'main']);
  if (!(await hasCommits(dir))) await commitAll(dir, 'YuMeewADE: 初始提交');
}

export async function currentBranch(dir: string): Promise<string> {
  return (await gitOk(dir, ['symbolic-ref', '--short', 'HEAD'])).trim();
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
  if (result.code < 0 || result.truncated) throw new AppError('internal', 'git_failed');
  return result.code === 0;
}

export function isLocalSecret(file: string): boolean {
  const name = file.split(/[\\/]/).at(-1) ?? '';
  return name.startsWith('.env') || name === '.npmrc' || name.startsWith('.dev.vars');
}
