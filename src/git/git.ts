// git 指令包裝：唯一呼叫 git 的地方。環境最小化、不提示輸入、身分缺省時用 YuMeewADE。

import { spawn } from 'node:child_process';
import { minimalEnv } from '../cli/process.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ENV = minimalEnv([]);
const IDENTITY = ['-c', 'user.name=YuMeewADE', '-c', 'user.email=yumeewade@localhost'];

export function git(cwd: string, args: string[], opts: { maxBytes?: number } = {}): Promise<GitResult> {
  const { promise, resolve, reject } = Promise.withResolvers<GitResult>();
  const child = spawn('git', [...IDENTITY, ...args], { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const max = opts.maxBytes ?? 10_000_000;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => {
    if (stdout.length < max) stdout += c;
  });
  child.stderr.on('data', (c: string) => {
    if (stderr.length < 4000) stderr += c;
  });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  return promise;
}

/** 失敗就丟 500（原因進日誌）；成功回 stdout。 */
export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) {
    log.error('git 失敗', undefined, { cwd, args, code: r.code, stderr: r.stderr.slice(0, 500) });
    throw new AppError('internal', 'git 指令失敗', { cause: new Error(r.stderr.slice(0, 500)) });
  }
  return r.stdout;
}

export async function isRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function hasCommits(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
}

/** 把工作樹全部提交；沒有變更回 false。 */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await gitOk(dir, ['add', '-A']);
  const staged = await git(dir, ['diff', '--cached', '--quiet']);
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
  return (await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).code === 0;
}
