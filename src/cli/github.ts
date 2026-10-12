import { findExecutable, minimalEnv, spawnCli, terminateTree } from './process.ts';
import { AppError } from '../shared/errors.ts';
import type { GitPullRequestStatus } from '../shared/types.ts';
import type { GithubReviewStatus, GithubPullRequest, GithubComment, GithubIssue, GithubFeedbackInput, GithubFeedbackRemote, GithubReviewThread } from '../shared/github.ts';

// 30 threads × 10 comments × 4,000 characters, with worst-case JSON escaping and metadata headroom.
const JSON_OUTPUT_LIMIT = 8_000_000;
type GithubInput = { action: 'status' } | { action: 'review'; branch: string } | { action: 'issues'; search: string } | { action: 'issue'; number: number } | { action: 'create'; title: string; body: string; base: string; head: string } | GithubFeedbackInput;
export function github(root: string, input: { action: 'status' }, command?: string): Promise<GitPullRequestStatus>;
export function github(root: string, input: { action: 'review'; branch: string }, command?: string): Promise<GithubReviewStatus>;
export function github(root: string, input: { action: 'issues'; search: string }, command?: string): Promise<GithubIssue[]>;
export function github(root: string, input: { action: 'issue'; number: number }, command?: string): Promise<GithubIssue>;
export function github(root: string, input: Extract<GithubInput, { action: 'create' }>, command?: string): Promise<{ url: string }>;
export function github(root: string, input: GithubFeedbackInput, command?: string): Promise<GithubFeedbackRemote>;
export async function github(root: string, input: GithubInput, command = 'gh'): Promise<GitPullRequestStatus | GithubReviewStatus | GithubIssue | GithubIssue[] | { url: string } | GithubFeedbackRemote> {
  const env = { ...minimalEnv([]), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  const executable = await findExecutable(command, env, root);
  if (!executable) {
    if (input.action === 'review') return { available: false, authenticated: false, repository: null, pr: null };
    if (input.action === 'status') return { available: false, authenticated: false, repository: null };
    throw new AppError('unavailable', 'gh_unavailable');
  }
  const run = (args: string[], outputLimit = 64_000): Promise<{ code: number; stdout: string }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string }>();
    const child = spawnCli(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
    let stdout = ''; let overflow = false; let timedOut = false; let stop: (() => void) | undefined;
    const deadline = setTimeout(() => { timedOut = true; stop = terminateTree(child, () => resolve({ code: -1, stdout: '' })); }, 120_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { if (stdout.length + chunk.length > outputLimit) overflow = true; else stdout += chunk; });
    child.on('error', () => { clearTimeout(deadline); stop?.(); reject(new AppError('unavailable', 'gh_unavailable')); });
    child.on('close', code => { clearTimeout(deadline); stop?.(); resolve({ code: overflow || timedOut ? -1 : code ?? -1, stdout }); });
    return promise;
  };
  const authenticated = (await run(['auth', 'status'])).code === 0;
  if (!authenticated) {
    if (input.action === 'review') return { available: true, authenticated: false, repository: null, pr: null };
    if (input.action === 'status') return { available: true, authenticated: false, repository: null };
    throw new AppError('unavailable', 'gh_auth_required');
  }
  const repoResult = await run(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const repository = repoResult.code === 0 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoResult.stdout.trim()) ? repoResult.stdout.trim() : null;
  if (input.action === 'status') return { available: true, authenticated: true, repository };
  if (!repository) throw new AppError('bad_request', 'gh_remote_required');
  if (input.action === 'feedback-read' || input.action === 'feedback-write') {
    if (!validRepository(input.repository) || input.repository !== repository || !Number.isSafeInteger(input.number) || input.number <= 0 || !['thread', 'issue'].includes(input.kind)) throw new AppError('conflict', 'gh_pr_failed');
    const json = async (args: string[]): Promise<unknown> => {
      const result = await run(args, JSON_OUTPUT_LIMIT);
      if (result.code !== 0) throw new AppError('conflict', 'gh_pr_failed');
      try { return JSON.parse(result.stdout); } catch { throw new AppError('conflict', 'gh_pr_failed'); }
    };
    const read = async (): Promise<GithubFeedbackRemote> => {
      if (input.kind === 'issue') {
        const issue = parseIssue(await json(['issue', 'view', String(input.number), '--repo', repository, '--json', 'number,title,body,url,state,updatedAt', '--jq', '{number,title,body:(.body[:10000]),url,state,contentVersion:.updatedAt}']));
        if (issue.number !== input.number || !identityUrl(issue.url, repository, 'issues', input.number)) throw new AppError('conflict', 'gh_pr_failed');
        return { repository, issue, url: issue.url, headOid: '' };
      }
      if (!validNodeId(input.threadId)) throw new AppError('bad_request', 'field_type');
      const data = object(await json(['api', 'graphql', '-f', 'query=query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved path line pullRequest{number url headRefOid repository{nameWithOwner}} comments(first:10){nodes{id author{login} body url}}}}}', '-f', `id=${input.threadId}`, '--jq', '.data.node | {id,isResolved,path,line,pullRequest,comments:{nodes:(.comments.nodes|map({id,author,body:(.body[:4000]),url}))}}']));
      const pr = object(data['pullRequest']);
      if (data['id'] !== input.threadId || pr['number'] !== input.number || object(pr['repository'])['nameWithOwner'] !== repository || !identityUrl(text(pr['url']), repository, 'pull', input.number) || !/^[a-f0-9]{40,64}$/i.test(text(pr['headRefOid']))) throw new AppError('conflict', 'gh_pr_failed');
      return { repository, thread: parseThread(data), url: text(pr['url']), headOid: text(pr['headRefOid']) };
    };
    const current = await read();
    if (input.action === 'feedback-read') return current;
    if (input.confirmed !== true) throw new AppError('bad_request', 'git_confirm_required');
    if (input.body.length > 10000 || input.title.length > 300 || /[\0]/.test(input.body + input.title)) throw new AppError('bad_request', 'field_type');
    if (input.kind === 'thread') {
      if (current.headOid !== input.headOid || current.thread?.resolved !== input.expectedResolved || !['reply', 'resolve', 'unresolve'].includes(input.operation)) throw new AppError('conflict', 'gh_pr_failed');
      if (!input.commentId || !validNodeId(input.commentId)) throw new AppError('conflict', 'gh_pr_failed');
      const pinned = object(await json(['api', 'graphql', '-f', 'query=query($id:ID!){node(id:$id){... on PullRequestReviewComment{id pullRequest{number url repository{nameWithOwner}}}}}', '-f', `id=${input.commentId}`, '--jq', '.data.node']));
      const pinnedPr = object(pinned['pullRequest']);
      if (pinned['id'] !== input.commentId || pinnedPr['number'] !== input.number || object(pinnedPr['repository'])['nameWithOwner'] !== repository || !identityUrl(text(pinnedPr['url']), repository, 'pull', input.number)) throw new AppError('conflict', 'gh_pr_failed');
      if (input.operation === 'reply' && !input.body.trim()) throw new AppError('bad_request', 'field_type');
      const mutation = input.operation === 'reply'
        ? 'mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}'
        : input.operation === 'resolve'
          ? 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}'
          : 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}';
      const response = object(await json(['api', 'graphql', '-f', `query=${mutation}`, '-f', `id=${input.threadId}`, ...(input.operation === 'reply' ? ['-f', `body=${input.body}`] : [])]));
      const payload = object(object(response['data'])[input.operation === 'reply' ? 'addPullRequestReviewThreadReply' : input.operation === 'resolve' ? 'resolveReviewThread' : 'unresolveReviewThread']);
      if (response['errors'] || (input.operation === 'reply' ? !validNodeId(text(object(payload['comment'])['id'])) : object(payload['thread'])['id'] !== input.threadId)) throw new AppError('conflict', 'gh_pr_failed');
      if (input.operation !== 'reply') current.thread!.resolved = input.operation === 'resolve';
    } else {
      if (current.issue?.state !== input.expectedState) throw new AppError('conflict', 'gh_pr_failed');
      const endpoint = `repos/${repository}/issues/${input.number}`;
      if (input.operation === 'reply') {
        if (!input.body.trim()) throw new AppError('bad_request', 'field_type');
        await json(['api', `${endpoint}/comments`, '--method', 'POST', '-f', `body=${input.body}`]);
      } else if (input.operation === 'close') current.issue = parseIssue(await json(['api', endpoint, '--method', 'PATCH', '-f', 'state=closed']));
      else if (input.operation === 'update') {
        if (!input.expectedContentVersion || current.issue?.contentVersion !== input.expectedContentVersion) throw new AppError('conflict', 'gh_pr_failed');
        if (!input.title.trim()) throw new AppError('bad_request', 'title_required');
        current.issue = parseIssue(await json(['api', endpoint, '--method', 'PATCH', '-f', `title=${input.title}`, '-f', `body=${input.body}`]));
      } else throw new AppError('bad_request', 'field_type');
    }
    // Do not make confirmed writes depend on another read: a failed refresh would allow duplicate retries.
    return current;
  }
  if (input.action === 'issues' || input.action === 'issue') {
    if (input.action === 'issue' && (!Number.isSafeInteger(input.number) || input.number <= 0) || input.action === 'issues' && (input.search.length > 300 || input.search.includes('\0'))) throw new AppError('bad_request', 'field_type');
    const args = input.action === 'issues'
      ? ['issue', 'list', '--repo', repository, '--state', 'open', '--limit', '30', '--json', 'number,title,url', ...(input.search ? ['--search', input.search] : [])]
      : ['issue', 'view', String(input.number), '--repo', repository, '--json', 'number,title,body,url,state,updatedAt', '--jq', '{number,title,body:(.body[:10000]),url,state,contentVersion:.updatedAt}'];
    const result = await run(args, JSON_OUTPUT_LIMIT);
    if (result.code !== 0) throw new AppError('conflict', 'gh_pr_failed');
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch { throw new AppError('conflict', 'gh_pr_failed'); }
    if (input.action === 'issue') return parseIssue(value);
    if (!Array.isArray(value)) throw new AppError('conflict', 'gh_pr_failed');
    return value.slice(0, 30).map(parseIssue);
  }
  if (input.action === 'review') {
    const json = async (args: string[]): Promise<unknown> => {
      const result = await run(args, JSON_OUTPUT_LIMIT);
      if (result.code !== 0) throw new AppError('conflict', 'gh_pr_failed');
      try { return JSON.parse(result.stdout); } catch { throw new AppError('conflict', 'gh_pr_failed'); }
    };
    const list = await json(['pr', 'list', '--repo', repository, '--head', input.branch, '--state', 'all', '--limit', '1', '--json', 'number']);
    if (!Array.isArray(list)) throw new AppError('conflict', 'gh_pr_failed');
    if (!list.length) return { available: true, authenticated: true, repository, pr: null };
    const number = object(list[0])['number'];
    if (!Number.isSafeInteger(number) || (number as number) <= 0) throw new AppError('conflict', 'gh_pr_failed');
    const value = await json(['pr', 'view', String(number), '--repo', repository, '--json', 'number,title,url,state,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments', '--jq', '{number,title,url,state,mergeStateStatus,reviewDecision,statusCheckRollup:(.statusCheckRollup[:50]),reviews:(.reviews[-30:]|map({author,body:(.body[:4000]),url,state})),comments:(.comments[-30:]|map({author,body:(.body[:4000]),url}))}']);
    const [owner, name] = repository.split('/');
    const threads = await json(['api', 'graphql', '-f', `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:30){nodes{id isResolved path line comments(first:10){nodes{id author{login} body url}}}}}}}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '--jq', '.data.repository.pullRequest.reviewThreads.nodes | map({id,isResolved,path,line,comments:{nodes:(.comments.nodes|map({id,author,body:(.body[:4000]),url}))}})']);
    return { available: true, authenticated: true, repository, pr: parsePullRequest(value, threads) };
  }
  const result = await run(['pr', 'create', '--repo', repository, '--title', input.title, '--body', input.body, '--base', input.base, '--head', input.head]);
  const url = result.stdout.trim();
  if (result.code !== 0 || !/^https:\/\/[^\s/]+\/[^\s]+\/pull\/\d+$/.test(url)) throw new AppError('conflict', 'gh_pr_failed');
  return { url };
}

function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const text = (value: unknown, limit = 4000): string => typeof value === 'string' ? value.slice(0, limit) : '';
const url = (value: unknown): string => { const s = text(value); return /^https:\/\/[^\s]+$/.test(s) ? s : ''; };
function comments(value: unknown): GithubComment[] {
  return (Array.isArray(value) ? value : []).slice(-30).map(item => { const v = object(item); return { id: text(v['id'], 200), author: text(object(v['author'])['login'], 200), body: text(v['body']), url: url(v['url']), state: text(v['state'], 100) }; });
}
export function parsePullRequest(value: unknown, threads: unknown): GithubPullRequest {
  const v = object(value); const number = v['number'];
  if (!Number.isSafeInteger(number) || (number as number) <= 0 || !url(v['url']) || !Array.isArray(threads)) throw new AppError('conflict', 'gh_pr_failed');
  return { number: number as number, title: text(v['title'], 300), url: url(v['url']), state: text(v['state'], 100), mergeState: text(v['mergeStateStatus'], 100), reviewDecision: text(v['reviewDecision'], 100),
    checks: (Array.isArray(v['statusCheckRollup']) ? v['statusCheckRollup'] : []).slice(0, 50).map(item => { const c = object(item); return { name: text(c['name'] ?? c['context'], 300), status: text(c['status'] ?? c['state'], 100), conclusion: text(c['conclusion'], 100) }; }),
    reviews: comments(v['reviews']), comments: comments(v['comments']), threads: threads.slice(0, 30).map(parseThread) };
}

export function parseIssue(value: unknown): GithubIssue {
  const v = object(value);
  if (!Number.isSafeInteger(v['number']) || (v['number'] as number) <= 0 || !text(v['title'], 300).trim() || !/^https:\/\/[^\s/]+\/[^\s]+\/issues\/\d+$/.test(url(v['html_url'] ?? v['url']))) throw new AppError('conflict', 'gh_pr_failed');
  const version = text(v['contentVersion'] ?? v['updated_at'], 100);
  return { number: v['number'] as number, title: text(v['title'], 300), body: text(v['body'], 10_000), url: url(v['html_url'] ?? v['url']), state: text(v['state'], 30).toUpperCase(), ...(version ? { contentVersion: version } : {}) };
}

const validRepository = (value: string): boolean => value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && !value.includes('..');
const validNodeId = (value: string): boolean => /^[A-Za-z0-9_=-]{1,200}$/.test(value);
const identityUrl = (value: string, repo: string, kind: string, number: number): boolean => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && u.pathname === `/${repo}/${kind}/${number}`; } catch { return false; }
};
function parseThread(value: unknown): GithubReviewThread {
  const tr = object(value);
  return { id: text(tr['id'], 200), resolved: tr['isResolved'] === true, path: text(tr['path'], 1000), line: typeof tr['line'] === 'number' && Number.isSafeInteger(tr['line']) && tr['line'] > 0 ? tr['line'] : null, comments: comments(object(tr['comments'])['nodes']).slice(0, 10) };
}
