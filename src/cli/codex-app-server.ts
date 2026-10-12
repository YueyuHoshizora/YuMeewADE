// Protocol source: codex-cli 0.162.1 app-server generate-json-schema / generate-ts.
// This transport is deliberately independent of the exec JSONL parser.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CliCommandConfig } from '../shared/config.ts';
import type { CliEvent, CliRun, SendOptions, RunOutcome } from './provider.ts';
import { findExecutable, spawnCli, terminateTree } from './process.ts';
import { slashName } from './commands.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid app-server message');
  return value as Record<string, unknown>;
}
/** Approval request fields that identify the request rather than describe what would be allowed. */
const APPROVAL_BOOKKEEPING = new Set(['threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId']);
export function codexAppServerRun(cfg: CliCommandConfig, opts: SendOptions, env: NodeJS.ProcessEnv, onEvent: (event: CliEvent) => void): CliRun {
  if (opts.readonly) throw new Error('Unsupported app-server operation');
  const command = opts.slashCommand === undefined ? null : slashName(opts.slashCommand);
  if (command !== null && command !== 'compact' && command !== 'review') throw new Error('Unsupported app-server operation');
  const reviewInstructions = command === 'review' ? opts.slashCommand!.trim().slice('/review'.length).trim() : '';
  if (opts.effort && (opts.effort.length > 100 || /[\0\r\n]/u.test(opts.effort))) throw new Error('Invalid reasoning effort');
  const completion = Promise.withResolvers<RunOutcome>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let cancelTermination: (() => void) | undefined;
  let stopped = false; let settled = false; let completed = false; let failed = false;
  let thread = ''; let turn = ''; let text = ''; let buffer = ''; let sequence = 0;
  // A review runs as a child turn whose rootTurnId is the turn review/start returned; both ids belong to this run.
  const turns = new Set<string>();
  const ownTurn = (id: unknown) => turns.size === 0 || (typeof id === 'string' && turns.has(id));
  const started = Date.now(); const runId = randomUUID();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const approvals = new Map<string | number, { deny: () => void }>();
  const streamedItems = new Set<string>();
  // File-change approvals only carry the item id; the files and diff arrive earlier in that item's `item/started`.
  const fileChanges = new Map<string, { files: string; diff: string }>();
  const send = (value: unknown) => { if (!child || child.stdin.destroyed) throw new Error('App-server disconnected'); child.stdin.write(JSON.stringify(value) + '\n'); };
  const denyAll = () => { for (const approval of approvals.values()) approval.deny(); approvals.clear(); };
  const finish = (outcome: RunOutcome) => {
    if (settled) return; settled = true;
    clearTimeout(deadline); clearTimeout(interruptTimer); denyAll();
    cancelTermination?.();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('App-server disconnected')); } pending.clear();
    completion.resolve(outcome);
  };
  const fail = () => {
    if (settled || failed) return; failed = true;
    onEvent({ type: 'error', reason: 'Codex app-server failed' });
    if (child) cancelTermination = terminateTree(child, () => finish({ ok: false, stopped, reason: 'Codex app-server failed' }));
    else finish({ ok: false, stopped, reason: 'Codex app-server failed' });
  };
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (pending.size >= 16) return Promise.reject(new Error('Too many app-server requests'));
    const id = ++sequence; const result = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { pending.delete(id); result.reject(new Error('App-server request timed out')); fail(); }, 30_000);
    pending.set(id, { ...result, timer }); send({ id, method, params }); return result.promise;
  };
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (settled || stopped) return; stopped = true; denyAll();
    if (thread && turn) void request('turn/interrupt', { threadId: thread, turnId: turn }).catch(fail);
    interruptTimer = setTimeout(() => { if (child) cancelTermination = terminateTree(child, () => finish({ ok: false, stopped: true })); else finish({ ok: false, stopped: true }); }, 2000);
  };
  const deadline = setTimeout(fail, 7_200_000);
  const handle = (value: unknown) => {
    const message = object(value);
    if (typeof message['method'] !== 'string') {
      const id = message['id']; if (typeof id !== 'number' || !pending.has(id)) throw new Error('Unexpected RPC response');
      const item = pending.get(id)!; pending.delete(id); clearTimeout(item.timer);
      if (message['error']) item.reject(new Error('App-server request failed')); else item.resolve(message['result']); return;
    }
    const method = message['method']; const params = object(message['params'] ?? {});
    const id = message['id'];
    if (id !== undefined) {
      if ((typeof id !== 'string' && typeof id !== 'number') || approvals.has(id)) throw new Error('Invalid server request');
      const supported = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval';
      if (!supported) { send({ id, error: { code: -32601, message: 'Unsupported request' } }); return; }
      if (params['threadId'] !== thread || !ownTurn(params['turnId']) || typeof params['itemId'] !== 'string') throw new Error('Approval scope mismatch');
      if (approvals.size >= 32) throw new Error('Too many approvals');
      const answer = (allow: boolean) => {
        const entry = approvals.get(id); if (!entry || settled) return; approvals.delete(id);
        send({ id, result: { decision: allow && !stopped ? 'accept' : 'decline' } });
      };
      const deny = () => { try { send({ id, result: { decision: 'decline' } }); } catch { /* transport already closed */ } };
      // TurnPermissions owns the configured deadline and resolves expiration through respond.
      approvals.set(id, { deny });
      // Protocol bookkeeping is not what the user approves; the card shows the action and, for edits, the announced changes.
      const shown = Object.fromEntries(Object.entries(params).filter(([key]) => !APPROVAL_BOOKKEEPING.has(key)));
      const changes = method === 'item/fileChange/requestApproval' ? fileChanges.get(String(params['itemId'])) : undefined;
      onEvent({ type: 'permission', id: `codex:${String(id)}`, tool: method === 'item/fileChange/requestApproval' ? 'fileChange' : 'commandExecution', input: { ...shown, ...changes }, respond: answer }); return;
    }
    if (params['threadId'] !== undefined && thread && params['threadId'] !== thread) throw new Error('Notification scope mismatch');
    if (params['turnId'] !== undefined && !ownTurn(params['turnId'])) throw new Error('Notification turn mismatch');
    if (method === 'error') { fail(); return; }
    if (method === 'turn/started') {
      const active = object(params['turn']); if (typeof active['id'] !== 'string') throw new Error('Missing turn id');
      const root = typeof active['rootTurnId'] === 'string' ? active['rootTurnId'] : active['id'];
      if (turns.size && !turns.has(root) && !turns.has(active['id'])) throw new Error('Notification turn mismatch');
      turns.add(active['id']); turns.add(root); turn ||= root;
      if (stopped) void request('turn/interrupt', { threadId: thread, turnId: turn }).catch(fail);
    }
    // Review mode streams the reviewer's raw output; only the exitedReviewMode summary is the answer.
    if (method === 'item/agentMessage/delta' && command !== 'review') {
      if (typeof params['delta'] !== 'string' || typeof params['itemId'] !== 'string') throw new Error('Invalid message delta');
      streamedItems.add(params['itemId']); text += params['delta']; if (text.length > 2_000_000) throw new Error('Output too large');
      onEvent({ type: 'delta', text: params['delta'] });
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = object(params['item']);
      if (item['type'] === 'fileChange' && typeof item['id'] === 'string' && Array.isArray(item['changes'])) {
        const changes = item['changes'].slice(0, 500).map(object);
        const kind = (change: Record<string, unknown>) => { const value = object(change['kind']); return `${String(value['type'] ?? 'update')}${typeof value['move_path'] === 'string' ? ` → ${value['move_path']}` : ''}`; };
        if (fileChanges.size >= 64) fileChanges.delete(fileChanges.keys().next().value!);
        fileChanges.set(item['id'], { files: changes.map(change => `${kind(change)} ${String(change['path'] ?? '')}`).join('\n'), diff: changes.map(change => String(change['diff'] ?? '')).join('\n').slice(0, 200_000) });
      }
      if (item['type'] === 'exitedReviewMode' && method === 'item/completed') {
        if (typeof item['review'] !== 'string') throw new Error('Invalid review'); text += item['review'];
        if (text.length > 2_000_000) throw new Error('Output too large'); onEvent({ type: 'delta', text: item['review'] });
      } else if (item['type'] === 'agentMessage') {
        if (method === 'item/completed' && command !== 'review' && !streamedItems.has(String(item['id']))) {
          if (typeof item['text'] !== 'string') throw new Error('Invalid message'); text += item['text'];
          if (text.length > 2_000_000) throw new Error('Output too large'); onEvent({ type: 'delta', text: item['text'] });
        }
      } else if (item['type'] !== 'userMessage' && item['type'] !== 'enteredReviewMode' && item['type'] !== 'exitedReviewMode') onEvent({ type: 'tool', text: String(item['command'] ?? item['type']).slice(0, 2000) });
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      if (typeof params['delta'] !== 'string') throw new Error('Invalid tool output'); onEvent({ type: 'tool', text: params['delta'].slice(0, 2000) });
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = object(object(params['tokenUsage'])['last']);
      const input = usage['inputTokens']; const output = usage['outputTokens']; const cached = usage['cachedInputTokens'];
      if (![input, output, cached].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid usage');
      onEvent({ type: 'usage', usage: { input: input as number, output: output as number, cached: cached as number } });
      onEvent({ type: 'tokens', runId, count: output as number, spanMs: Math.max(1, Date.now() - started), at: Date.now() });
    }
    if (method === 'turn/completed') {
      const result = object(params['turn']); if (result['id'] !== turn) { if (turns.has(String(result['id']))) return; throw new Error('Completed turn mismatch'); }
      denyAll();
      if (stopped || result['status'] === 'interrupted') { stopped = true; }
      else if (result['status'] !== 'completed' || result['error']) { fail(); return; }
      else { completed = true; onEvent({ type: 'result', text }); }
      child?.stdin.end();
    }
  };
  void (async () => {
    const executable = await findExecutable(cfg.command, env); if (!executable) throw new Error('CLI not found');
    if (command === 'compact' && !opts.resumeId) throw new Error('No Codex thread to compact');
    if (stopped) { finish({ ok: false, stopped: true }); return; }
    child = spawnCli(executable, cfg.appServerArgs ?? ['app-server', '--stdio'], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }) as ChildProcessWithoutNullStreams;
    child.on('error', fail); child.stdin.on('error', fail); child.stderr.resume();
    child.on('close', code => { if (!stopped && (!completed || code !== 0 || failed)) { onEvent({ type: 'error', reason: 'Codex app-server disconnected' }); finish({ ok: false, stopped: false, reason: 'Codex app-server disconnected' }); } else finish({ ok: completed && code === 0 && !failed && !stopped, stopped }); });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => {
      if (settled) return; buffer += chunk;
      if (Buffer.byteLength(buffer) > 2_097_152) { fail(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; try { handle(JSON.parse(line)); } catch { fail(); return; } }
    });
    await request('initialize', { clientInfo: { name: 'yumeewade', title: null, version: '1' }, capabilities: null });
    send({ method: 'initialized' });
    const full = opts.fullAccess ?? cfg.fullAccess;
    const common = { cwd: opts.cwd, model: opts.model ?? null, approvalPolicy: full ? 'never' : 'on-request', sandbox: full ? 'danger-full-access' : 'workspace-write', approvalsReviewer: 'user' };
    const response = object(await request(opts.resumeId ? 'thread/resume' : 'thread/start', { ...common, ...(opts.resumeId ? { threadId: opts.resumeId, excludeTurns: true } : {}) }));
    const metadata = object(response['thread']); if (typeof metadata['id'] !== 'string' || !metadata['id']) throw new Error('Missing thread id');
    thread = metadata['id']; onEvent({ type: 'session', id: thread });
    if (stopped) { child.stdin.end(); return; }
    let opened: Record<string, unknown> | undefined;
    if (command === 'compact') await request('thread/compact/start', { threadId: thread });
    else if (command === 'review') opened = object(await request('review/start', { threadId: thread, delivery: 'inline', target: reviewInstructions ? { type: 'custom', instructions: reviewInstructions } : { type: 'uncommittedChanges' } }));
    else opened = object(await request('turn/start', { threadId: thread, cwd: opts.cwd, model: opts.model ?? null, effort: opts.effort ?? null, approvalPolicy: common.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: full ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [opts.cwd, ...(opts.addDirs ?? [])], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, input: [{ type: 'text', text: opts.prompt, text_elements: [] }, ...(opts.images ?? []).map(image => ({ type: 'localImage', path: image }))] }));
    // thread/compact/start answers `{}`; its turn id arrives with turn/started.
    if (opened) {
      const active = object(opened['turn']); if (typeof active['id'] !== 'string') throw new Error('Missing turn id');
      turns.add(active['id']); turn = active['id'];
    }
    if (stopped && turn) void request('turn/interrupt', { threadId: thread, turnId: turn }).catch(fail);
  })().catch(fail);
  return { stop, done: completion.promise };
}
