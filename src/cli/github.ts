import { findExecutable, minimalEnv, spawnCli, terminateTree } from './process.ts';
import { AppError } from '../shared/errors.ts';
import type { GitPullRequestStatus } from '../shared/types.ts';

type GithubInput = { action: 'status' } | { action: 'create'; title: string; body: string; base: string; head: string };
export function github(root: string, input: { action: 'status' }, command?: string): Promise<GitPullRequestStatus>;
export function github(root: string, input: Extract<GithubInput, { action: 'create' }>, command?: string): Promise<{ url: string }>;
export async function github(root: string, input: GithubInput, command = 'gh'): Promise<GitPullRequestStatus | { url: string }> {
  const env = { ...minimalEnv([]), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  const executable = await findExecutable(command, env);
  if (!executable) {
    if (input.action === 'status') return { available: false, authenticated: false, repository: null };
    throw new AppError('unavailable', 'gh_unavailable');
  }
  const run = (args: string[]): Promise<{ code: number; stdout: string }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string }>();
    const child = spawnCli(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
    let stdout = ''; let overflow = false; let timedOut = false; let stop: (() => void) | undefined;
    const deadline = setTimeout(() => { timedOut = true; stop = terminateTree(child, () => resolve({ code: -1, stdout: '' })); }, 120_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { if (stdout.length + chunk.length > 64_000) overflow = true; else stdout += chunk; });
    child.on('error', () => { clearTimeout(deadline); stop?.(); reject(new AppError('unavailable', 'gh_unavailable')); });
    child.on('close', code => { clearTimeout(deadline); stop?.(); resolve({ code: overflow || timedOut ? -1 : code ?? -1, stdout }); });
    return promise;
  };
  const authenticated = (await run(['auth', 'status'])).code === 0;
  if (!authenticated) {
    if (input.action === 'status') return { available: true, authenticated: false, repository: null };
    throw new AppError('unavailable', 'gh_auth_required');
  }
  const repoResult = await run(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const repository = repoResult.code === 0 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoResult.stdout.trim()) ? repoResult.stdout.trim() : null;
  if (input.action === 'status') return { available: true, authenticated: true, repository };
  if (!repository) throw new AppError('bad_request', 'gh_remote_required');
  const result = await run(['pr', 'create', '--repo', repository, '--title', input.title, '--body', input.body, '--base', input.base, '--head', input.head]);
  const url = result.stdout.trim();
  if (result.code !== 0 || !/^https:\/\/[^\s/]+\/[^\s]+\/pull\/\d+$/.test(url)) throw new AppError('conflict', 'gh_pr_failed');
  return { url };
}
