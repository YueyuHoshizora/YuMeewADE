// Protocol source: codex-cli 0.162.1 app-server generate-json-schema / generate-ts.
// This transport is deliberately independent of the exec JSONL parser.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CliCommandConfig } from '../shared/config.ts';
import type { SlashCommand } from '../shared/types.ts';
import type { CliEvent, CliRun, SendOptions, RunOutcome } from './provider.ts';
import { findExecutable, spawnCli, terminateTree } from './process.ts';
import { slashName } from './commands.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid app-server message');
  return value as Record<string, unknown>;
}
/** Approval request fields that identify the request rather than describe what would be allowed. */
const APPROVAL_BOOKKEEPING = new Set(['threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId']);

/**
 * codex-cli 0.162.1 TUI commands that have an app-server request behind them (descriptions are the TUI's,
 * narrowed where only the listing half of an interactive manager exists). Pure terminal controls such as
 * /vim, /theme, /copy or /exit have none, nor do /init, /diff, /plan, /ps and /stop. `standalone` runs leave
 * the task's session and read position alone; the rest replace the session (new, fork, resume) or are turns.
 */
interface AppCommand extends SlashCommand { args: 'none' | 'optional' | 'required'; standalone: (argument: string) => boolean }
const always = () => true;
const never = () => false;
const COMMANDS: AppCommand[] = [
  { name: 'apps', description: 'list installed apps', args: 'none', standalone: always },
  { name: 'archive', description: 'archive this session', args: 'none', standalone: never },
  { name: 'btw', description: 'start a side conversation in an ephemeral fork', argumentHint: '<question>', args: 'required', standalone: always },
  { name: 'clear', description: 'start a new chat', args: 'none', standalone: never },
  { name: 'compact', description: 'summarize conversation to prevent hitting the context limit', args: 'none', standalone: never },
  { name: 'debug-config', description: 'show config layers and requirement sources for debugging', args: 'none', standalone: always },
  { name: 'delete', description: 'permanently delete this session', args: 'none', standalone: never },
  { name: 'experimental', description: 'list experimental features', args: 'none', standalone: always },
  { name: 'fork', description: 'fork the current chat', args: 'none', standalone: never },
  // Setting an objective makes Codex start working on it at once; viewing or clearing does not.
  { name: 'goal', description: 'set or view the goal for a long-running task', argumentHint: '[objective|clear]', args: 'optional', standalone: argument => !argument || argument === 'clear' },
  { name: 'hooks', description: 'view lifecycle hooks', args: 'none', standalone: always },
  { name: 'mcp', description: 'list MCP servers and their tools', args: 'none', standalone: always },
  { name: 'new', description: 'start a new chat during a conversation', args: 'none', standalone: never },
  { name: 'permissions', description: 'list permission profiles', args: 'none', standalone: always },
  { name: 'plugins', description: 'list installed plugins', args: 'none', standalone: always },
  { name: 'rename', description: 'rename the current thread', argumentHint: '<name>', args: 'required', standalone: always },
  { name: 'resume', description: 'resume a saved chat, or list them', argumentHint: '[thread id]', args: 'optional', standalone: argument => !argument },
  { name: 'review', description: 'review my current changes and find issues', argumentHint: '[instructions]', args: 'optional', standalone: never },
  { name: 'side', description: 'start a side conversation in an ephemeral fork', argumentHint: '<question>', args: 'required', standalone: always },
  { name: 'skills', description: 'list skills', args: 'none', standalone: always },
  { name: 'status', description: 'show current session configuration and usage limits', args: 'none', standalone: always },
  { name: 'usage', description: 'view account usage', args: 'none', standalone: always },
];
export const CODEX_APP_COMMANDS: ReadonlyMap<string, AppCommand> = new Map(COMMANDS.map(command => [command.name, command]));
/** Needs the task's existing Codex thread; without one the command has nothing to act on. */
const THREAD_COMMANDS = new Set(['archive', 'btw', 'compact', 'delete', 'fork', 'goal', 'rename', 'side']);

/** Whether `argument` is acceptable for `command`; resume takes one thread id, rename one line. */
export function codexCommandArgument(command: AppCommand, argument: string): boolean {
  if (command.args === 'none') return !argument;
  if (command.args === 'required' && !argument) return false;
  if (command.name === 'resume') return !argument || /^[\w:-]{1,200}$/u.test(argument);
  if (command.name === 'rename') return argument.length <= 200 && !/[\r\n]/u.test(argument);
  return true;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid app-server report');
  return value;
}
const str = (value: unknown) => typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
const line = (value: string) => value.replace(/\s+/gu, ' ').trim();
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value;
const time = (seconds: unknown) => typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '';
const bullets = (rows: string[]) => rows.length ? rows.join('\n') : '(none)';

export interface CodexSkill { name: string; description: string; path: string }
/** Enabled skills from `skills/list`; disabled ones are not invocable. */
export function codexSkills(result: unknown): CodexSkill[] {
  const skills = new Map<string, CodexSkill>();
  for (const entry of array(object(result)['data'])) {
    for (const value of array(object(entry)['skills'])) {
      const skill = object(value);
      if (skill['enabled'] !== true || typeof skill['name'] !== 'string' || typeof skill['path'] !== 'string' || !skill['path']) continue;
      if (!skills.has(skill['name'])) skills.set(skill['name'], { name: skill['name'], description: str(skill['description']), path: skill['path'] });
    }
  }
  return [...skills.values()];
}

function rateLimits(result: unknown): string[] {
  const report = object(result);
  const byId = report['rateLimitsByLimitId'] && typeof report['rateLimitsByLimitId'] === 'object' ? Object.values(object(report['rateLimitsByLimitId'])) : [report['rateLimits']];
  const rows: string[] = [];
  for (const value of byId) {
    if (!value || typeof value !== 'object') continue;
    const limit = object(value);
    for (const window of ['primary', 'secondary'] as const) {
      if (!limit[window] || typeof limit[window] !== 'object') continue;
      const usage = object(limit[window]);
      rows.push(`- ${str(limit['limitName'] ?? limit['limitId'])} ${window}: ${str(usage['usedPercent'])}% used, ${str(usage['windowDurationMins'])} min window, resets ${time(usage['resetsAt'])}`);
    }
    const credits = limit['credits'] && typeof limit['credits'] === 'object' ? object(limit['credits']) : undefined;
    if (credits) rows.push(`- ${str(limit['limitName'] ?? limit['limitId'])} credits: ${credits['unlimited'] === true ? 'unlimited' : str(credits['balance'])}`);
  }
  return rows;
}

function goalReport(value: unknown): string {
  if (value === null || value === undefined) return 'goal: (none)';
  const goal = object(value);
  return [`goal: ${str(goal['objective'])}`, `status: ${str(goal['status'])}`, `tokens used: ${str(goal['tokensUsed'])}${goal['tokenBudget'] === null || goal['tokenBudget'] === undefined ? '' : ` / ${str(goal['tokenBudget'])}`}`, `time used: ${str(goal['timeUsedSeconds'])} s`].join('\n');
}

type Request = (method: string, params: unknown) => Promise<unknown>;
interface ControlContext { request: Request; cwd: string; thread: string | undefined; argument: string; common: Record<string, unknown>; session: (id: string) => void; end: () => void }
const threadId = (response: unknown) => {
  const metadata = object(object(response)['thread']);
  if (typeof metadata['id'] !== 'string' || !metadata['id']) throw new Error('Missing thread id');
  return metadata['id'];
};
// A thread only reaches disk with its first turn (0.162.1: resuming an unused thread/start id fails with
// "no rollout found"), so /new ends the task's session and the next instruction starts the thread, as the TUI's does.
const NEXT = 'thread: (a new one starts with the next instruction)';
// Reports read account/config-wide state: their thread-scoped variants want a loaded thread, and controls load none.
const CONTROLS: Record<string, (context: ControlContext) => Promise<string>> = {
  apps: async ({ request }) => bullets(array(object(await request('app/installed', {}))['apps']).map(object)
    .map(app => `- ${str(app['runtimeName'] ?? app['id'])} (${str(app['id'])})${app['enabled'] === false ? ' — disabled' : ''}`)),
  archive: async ({ request, thread, end }) => { await request('thread/archive', { threadId: thread }); end(); return `archived: ${thread}\n${NEXT}`; },
  clear: async ({ end }) => { end(); return NEXT; },
  'debug-config': async ({ request, cwd }) => {
    const layers = array(object(await request('config/read', { cwd, includeLayers: true }))['layers'] ?? []).map(object).map(layer => {
      const source = object(layer['name']);
      const where = str(source['file'] ?? source['dotCodexFolder'] ?? source['id'] ?? source['domain']);
      return `- ${str(source['type'])}${where ? ` ${where}` : ''}${layer['disabledReason'] ? ` — disabled: ${str(layer['disabledReason'])}` : ''}`;
    });
    const requirements = object(await request('configRequirements/read', undefined))['requirements'];
    return `config layers:\n${bullets(layers)}\n\nrequirements:\n${requirements ? clip(JSON.stringify(requirements, null, 2), 20_000) : '(none)'}`;
  },
  delete: async ({ request, thread, end }) => { await request('thread/delete', { threadId: thread }); end(); return `deleted: ${thread}\n${NEXT}`; },
  experimental: async ({ request }) => bullets(array(object(await request('experimentalFeature/list', {}))['data']).map(object)
    .filter(feature => feature['stage'] !== 'removed' && feature['stage'] !== 'deprecated')
    .map(feature => `- \`${str(feature['name'])}\` (${str(feature['stage'])}) ${feature['enabled'] === true ? 'on' : 'off'}${feature['description'] ? ` — ${line(str(feature['description']))}` : ''}`)),
  fork: async ({ request, thread, common, session }) => {
    const id = threadId(await request('thread/fork', { ...common, threadId: thread, excludeTurns: true })); session(id);
    return `forked: ${thread}\nthread: ${id}`;
  },
  goal: async ({ request, thread, argument }) => {
    if (argument === 'clear') return `cleared: ${str(object(await request('thread/goal/clear', { threadId: thread }))['cleared'])}`;
    return goalReport(object(await request('thread/goal/get', { threadId: thread }))['goal']);
  },
  hooks: async ({ request, cwd }) => bullets(array(object(await request('hooks/list', { cwds: [cwd] }))['data']).flatMap(entry => array(object(entry)['hooks']).map(object))
    .map(hook => `- ${str(hook['eventName'])}${hook['matcher'] ? ` [${str(hook['matcher'])}]` : ''}: ${clip(line(hook['handlerType'] === 'command' ? str(hook['command']) : `${str(hook['server'])} ${str(hook['tool'])}`), 200)}${hook['enabled'] === false ? ' — disabled' : ''}`)),
  mcp: async ({ request }) => bullets(array(object(await request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }))['data']).map(object).map(server => {
    const tools = server['tools'] && typeof server['tools'] === 'object' ? Object.keys(object(server['tools'])) : [];
    const listed = server['toolsError'] ? `tools error: ${clip(line(str(server['toolsError'])), 300)}` : tools.length ? clip(tools.join(', '), 2000) : '(no tools)';
    return `- \`${str(server['name'])}\`${server['authStatus'] ? ` (${str(server['authStatus'])})` : ''}: ${listed}`;
  })),
  new: async ({ end }) => { end(); return NEXT; },
  permissions: async ({ request, cwd }) => bullets(array(object(await request('permissionProfile/list', { cwd }))['data']).map(object)
    .map(profile => `- \`${str(profile['id'])}\`${profile['allowed'] === false ? ' — not allowed' : ''}${profile['description'] ? ` — ${line(str(profile['description']))}` : ''}`)),
  plugins: async ({ request, cwd }) => bullets(array(object(await request('plugin/installed', { cwds: [cwd] }))['marketplaces']).map(object)
    .flatMap(market => array(market['plugins']).map(object).filter(plugin => plugin['installed'] === true)
      .map(plugin => `- \`${str(plugin['name'])}\` ${str(plugin['localVersion'] ?? plugin['version'])} (${str(market['name'])})${plugin['enabled'] === false ? ' — disabled' : ''}`))),
  rename: async ({ request, thread, argument }) => { await request('thread/name/set', { threadId: thread, name: argument }); return `name: ${argument}`; },
  resume: async ({ request, cwd, argument, common, session }) => {
    if (argument) { const id = threadId(await request('thread/resume', { ...common, threadId: argument, excludeTurns: true })); session(id); return `thread: ${id}`; }
    const threads = array(object(await request('thread/list', { limit: 20, cwd, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] }))['data']).map(object);
    return bullets(threads.map(thread => `- \`${str(thread['id'])}\` ${time(thread['updatedAt'])} ${clip(line(str(thread['name'] ?? thread['preview'])), 120)}`));
  },
  skills: async ({ request, cwd }) => bullets(codexSkills(await request('skills/list', { cwds: [cwd] })).map(skill => `- \`${skill.name}\` — ${clip(line(skill.description), 300)}`)),
  status: async ({ request, cwd, thread }) => {
    const config = object(object(await request('config/read', { cwd }))['config']);
    const rows = ['model', 'model_reasoning_effort', 'service_tier', 'approval_policy', 'sandbox_mode'].map(key => `${key}: ${str(config[key]) || '(default)'}`);
    return [...(thread ? [`thread: ${thread}`] : []), ...rows, '', 'usage limits:', bullets(rateLimits(await request('account/rateLimits/read', undefined)))].join('\n');
  },
  usage: async ({ request }) => bullets(rateLimits(await request('account/rateLimits/read', undefined))),
};

/** One request on a short-lived app-server, for discovery outside any run (no thread, no turn). */
export async function codexAppServerRequest(cfg: CliCommandConfig, env: NodeJS.ProcessEnv, cwd: string, method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
  const executable = await findExecutable(cfg.command, env, cwd);
  if (!executable) throw new Error('CLI not found');
  const child = spawnCli(executable, cfg.appServerArgs ?? ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' }) as ChildProcessWithoutNullStreams;
  const answer = Promise.withResolvers<unknown>();
  const closed = Promise.withResolvers<void>();
  const timer = setTimeout(() => answer.reject(new Error('App-server request timed out')), timeoutMs);
  let buffer = '';
  child.on('error', error => answer.reject(error));
  child.on('close', () => { closed.resolve(); answer.reject(new Error('App-server disconnected')); });
  child.stdin.on('error', error => answer.reject(error));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 2_097_152) { answer.reject(new Error('Output too large')); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message: Record<string, unknown>;
      try { message = object(JSON.parse(text)); } catch { answer.reject(new Error('Invalid app-server message')); return; }
      if (message['method'] !== undefined) continue;
      if (message['id'] === 1) { child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n${JSON.stringify({ id: 2, method, params })}\n`); continue; }
      if (message['id'] === 2) { if (message['error']) answer.reject(new Error('App-server request failed')); else answer.resolve(message['result']); }
    }
  });
  child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'yumeewade', title: null, version: '1' }, capabilities: null } })}\n`);
  try { return await answer.promise; }
  finally {
    clearTimeout(timer);
    const cancel = terminateTree(child, () => closed.resolve());
    await closed.promise; cancel();
  }
}
export function codexAppServerRun(cfg: CliCommandConfig, opts: SendOptions, env: NodeJS.ProcessEnv, onEvent: (event: CliEvent) => void): CliRun {
  if (opts.readonly) throw new Error('Unsupported app-server operation');
  const command = opts.slashCommand === undefined ? null : slashName(opts.slashCommand);
  const argument = command === null ? '' : opts.slashCommand!.trim().slice(command.length + 1).trim();
  const builtin = command === null ? undefined : CODEX_APP_COMMANDS.get(command);
  // /fast is a task setting the core applies to every send; any other unknown name must be a skill, checked once the server is up.
  if (command === 'fast' || (builtin && !codexCommandArgument(builtin, argument))) throw new Error('Unsupported app-server operation');
  const control = builtin && Object.hasOwn(CONTROLS, builtin.name) && (builtin.name !== 'goal' || builtin.standalone(argument)) ? CONTROLS[builtin.name] : undefined;
  const reviewInstructions = command === 'review' ? argument : '';
  if (opts.effort && (opts.effort.length > 100 || /[\0\r\n]/u.test(opts.effort))) throw new Error('Invalid reasoning effort');
  const completion = Promise.withResolvers<RunOutcome>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let cancelTermination: (() => void) | undefined;
  let stopped = false; let settled = false; let completed = false; let failed = false;
  let thread = ''; let turn = ''; let text = ''; let buffer = ''; let sequence = 0;
  // Control commands are request/response only; whatever the server streams meanwhile is not this run's output.
  let controlling = false; let goalTimer: NodeJS.Timeout | undefined;
  // A review runs as a child turn whose rootTurnId is the turn review/start returned; both ids belong to this run.
  const turns = new Set<string>();
  const ownTurn = (id: unknown) => turns.size === 0 || (typeof id === 'string' && turns.has(id));
  const started = Date.now(); const runId = randomUUID();
  const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const approvals = new Map<string | number, { deny: () => void }>();
  const streamedItems = new Set<string>();
  // File-change approvals only carry the item id; the files and diff arrive earlier in that item's `item/started`.
  const fileChanges = new Map<string, { files: string; diff: string }>();
  const send = (value: unknown) => { if (!child || child.stdin.destroyed) throw new Error('App-server disconnected'); child.stdin.write(JSON.stringify(value) + '\n'); };
  const denyAll = () => { for (const approval of approvals.values()) approval.deny(); approvals.clear(); };
  const finish = (outcome: RunOutcome) => {
    if (settled) return; settled = true;
    clearTimeout(deadline); clearTimeout(interruptTimer); clearTimeout(goalTimer); denyAll();
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
    pending.set(id, { ...result, timer, method }); send({ id, method, params }); return result.promise;
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
      const item = pending.get(id)!;
      // The turn a start opens is registered right here: its deltas and turn/completed may follow in the same stdout
      // chunk, before any continuation awaiting this response gets to run.
      if (!message['error'] && (item.method === 'turn/start' || item.method === 'review/start')) {
        const active = object(object(message['result'])['turn']); if (typeof active['id'] !== 'string') throw new Error('Missing turn id');
        turns.add(active['id']); turn = active['id'];
      }
      pending.delete(id); clearTimeout(item.timer);
      if (message['error']) item.reject(new Error('App-server request failed')); else item.resolve(message['result']); return;
    }
    const method = message['method']; const params = object(message['params'] ?? {});
    const id = message['id'];
    // A control command has no turn to approve anything in, and nothing streams into its answer.
    if (controlling) { if (id !== undefined) send({ id, error: { code: -32601, message: 'Unsupported request' } }); return; }
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
    const executable = await findExecutable(cfg.command, env, opts.cwd); if (!executable) throw new Error('CLI not found');
    if (command !== null && THREAD_COMMANDS.has(command) && !opts.resumeId) throw new Error('No Codex thread for this command');
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
    // The thread holds the tier for its later turns, but a resumed thread does not keep it across processes (0.162.1).
    const common = { cwd: opts.cwd, model: opts.model ?? null, approvalPolicy: full ? 'never' : 'on-request', sandbox: full ? 'danger-full-access' : 'workspace-write', approvalsReviewer: 'user', ...(opts.fast === undefined ? {} : { serviceTier: opts.fast ? 'priority' : 'default' }) };
    const answer = (reply: string) => { completed = true; onEvent({ type: 'result', text: reply }); child!.stdin.end(); };
    if (control) {
      controlling = true;
      answer(await control({ request, cwd: opts.cwd, thread: opts.resumeId, argument, common, session: id => onEvent({ type: 'session', id }), end: () => onEvent({ type: 'sessionEnd' }) }));
      return;
    }
    const side = command === 'side' || command === 'btw';
    // A side question runs in an ephemeral fork: the task's own thread neither sees it nor changes.
    const response = object(side
      ? await request('thread/fork', { ...common, threadId: opts.resumeId, ephemeral: true, excludeTurns: true })
      : await request(opts.resumeId ? 'thread/resume' : 'thread/start', { ...common, ...(opts.resumeId ? { threadId: opts.resumeId, excludeTurns: true } : {}) }));
    const metadata = object(response['thread']); if (typeof metadata['id'] !== 'string' || !metadata['id']) throw new Error('Missing thread id');
    thread = metadata['id']; if (!side) onEvent({ type: 'session', id: thread });
    if (stopped) { child.stdin.end(); return; }
    const turnStart = (input: unknown[]) => request('turn/start', { threadId: thread, cwd: opts.cwd, model: opts.model ?? null, effort: opts.effort ?? null, approvalPolicy: common.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: full ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [opts.cwd, ...(opts.addDirs ?? [])], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, input: [...input, ...(opts.images ?? []).map(image => ({ type: 'localImage', path: image }))] });
    const prompt = (tail: string) => ({ type: 'text', text: tail ? `${opts.prompt}\n${tail}` : opts.prompt, text_elements: [] });
    // thread/compact/start answers `{}`; its turn id arrives with turn/started. Started turns are registered by handle().
    if (command === 'compact') await request('thread/compact/start', { threadId: thread });
    else if (command === 'review') await request('review/start', { threadId: thread, delivery: 'inline', target: reviewInstructions ? { type: 'custom', instructions: reviewInstructions } : { type: 'uncommittedChanges' } });
    else if (command === 'goal') {
      // Setting an active goal makes Codex start a turn toward it by itself; that turn (possibly already
      // streamed before this response is processed) is the answer. No turn means the goal itself is.
      const goal = object(await request('thread/goal/set', { threadId: thread, objective: argument, origin: 'user' }))['goal'];
      if (!turn && !completed) {
        if (object(goal)['status'] !== 'active') { answer(goalReport(goal)); return; }
        goalTimer = setTimeout(() => { if (!turn && !settled) answer(goalReport(goal)); }, 60_000);
      }
    } else if (side) await turnStart([prompt(argument)]);
    else if (command !== null) {
      const skill = codexSkills(await request('skills/list', { cwds: [opts.cwd] })).find(candidate => candidate.name === command);
      if (!skill) throw new Error('Unknown Codex command');
      // Mirrors the TUI composer: the `$name` mention in the text plus the skill attachment.
      await turnStart([prompt(`$${skill.name}${argument ? ` ${argument}` : ''}`), { type: 'skill', name: skill.name, path: skill.path }]);
    } else await turnStart([prompt('')]);
    if (stopped && turn) void request('turn/interrupt', { threadId: thread, turnId: turn }).catch(fail);
  })().catch(fail);
  return { stop, done: completion.promise };
}
