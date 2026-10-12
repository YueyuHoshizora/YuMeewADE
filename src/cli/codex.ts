// Codex --json adapter（含舊版 msg 事件）；工具不混入回答。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliCommandConfig } from '../shared/config.ts';
import { CREDITS_UNIT } from '../shared/types.ts';
import type { ExtraUsage, QuotaWindow, ResetCredit, ResetCredits, SlashCommand } from '../shared/types.ts';
import { findExecutable, minimalEnv, runLineProcess, terminateTree } from './process.ts';
import { quotaTime, type CliEvent, type CliProvider, type CliRun, type FastChange, type ResolvedCommand, type SendOptions } from './provider.ts';
import { codexPrompts, EXCLUDED_COMMANDS, expandCodexPrompt, slashName } from './commands.ts';
import { AppError } from '../shared/errors.ts';
import { readonlyConfigured, reviewArgs } from './readonly.ts';
import { CODEX_APP_COMMANDS, codexAppServerRequest, codexAppServerRun, codexCommandArgument, codexSkills, type CodexSkill } from './codex-app-server.ts';

type QuotaEvent = Extract<CliEvent, { type: 'quota' }>;

/** rollout 檔只讀尾端；token_count 每回合寫一次，最後一筆一定在尾端附近。 */
const ROLLOUT_TAIL_BYTES = 512 * 1024;
/** 啟動時找「最近一次」額度最多翻幾個 rollout 檔。 */
const LATEST_ROLLOUTS = 5;

export function codexArgs(cfg: CliCommandConfig, opts: SendOptions): string[] {
  const args = opts.readonly ? reviewArgs('codex', cfg, opts) : [...cfg.baseArgs];
  // Review is independent of ordinary base and permission flags.
  if (!opts.readonly) args.splice(args[0] === 'exec' ? 1 : 0, 0, ...((opts.fullAccess ?? cfg.fullAccess) ? cfg.fullAccessArgs : cfg.safeArgs));
  if (opts.model) args.push('-m', opts.model);
  if (opts.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`);
  for (const image of opts.images ?? []) args.push('-i', image);
  if (opts.resumeId) args.push('resume', opts.resumeId);
  args.push('-');
  return args;
}

/** rollout 的 `rate_limits`（primary／secondary：used_percent 0–100、window_minutes、resets_at 秒）→ 額度窗口。 */
export function codexQuota(limits: unknown, at: string): QuotaEvent | null {
  if (!limits || typeof limits !== 'object') return null;
  const l = limits as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = l[key];
    if (!w || typeof w !== 'object' || !('used_percent' in w) || typeof w.used_percent !== 'number') continue;
    const minutes = 'window_minutes' in w && typeof w.window_minutes === 'number' ? w.window_minutes : 0;
    const resets = 'resets_at' in w ? quotaTime(w.resets_at) : null;
    windows.push({
      label: minutes <= 0 ? key : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`,
      usedPercent: Math.round(Math.min(100, Math.max(0, w.used_percent)) * 10) / 10,
      resetsAt: resets,
    });
  }
  const limited = l['rate_limit_reached_type'] !== null && l['rate_limit_reached_type'] !== undefined;
  return windows.length || limited ? { type: 'quota', windows, limited, at } : null;
}

/** app-server `rateLimitResetCredits`：只收仍可用（available）的券，到期時間為 Unix 秒；格式不符的整體忽略。 */
export function codexResetCredits(value: unknown): ResetCredits | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const summary = value as Record<string, unknown>;
  const count = summary['availableCount'];
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
  const rows = Array.isArray(summary['credits']) ? summary['credits'] : [];
  const credits: ResetCredit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const credit = row as Record<string, unknown>;
    if (credit['status'] !== 'available') continue;
    const expires = credit['expiresAt'];
    credits.push({
      title: typeof credit['title'] === 'string' && credit['title'] ? credit['title'].slice(0, 80) : null,
      expiresAt: quotaTime(expires),
    });
  }
  credits.sort((a, b) => (a.expiresAt ?? '9').localeCompare(b.expiresAt ?? '9'));
  return { availableCount: count, credits };
}

/** app-server 的 `credits`（額外點數）：balance 是十進位字串，單位是點數（不是美元），以 currency `credits` 表示；格式不符的整體忽略；沒有餘額數字視為 0。 */
export function codexExtraUsage(value: unknown): ExtraUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c['hasCredits'] !== 'boolean' || typeof c['unlimited'] !== 'boolean') return undefined;
  const balance = typeof c['balance'] === 'string' && /^\d+(\.\d+)?$/.test(c['balance']) ? Number(c['balance']) : 0;
  return { unlimited: c['unlimited'], currency: CREDITS_UNIT, balance };
}

/** app-server `account/rateLimits/read` 的回應（camelCase、同一份後端即時資料）→ 額度窗口與重置券；窗口沿用 rollout 的解析。 */
export function codexAppServerQuota(result: unknown, at: string): QuotaEvent | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const byId = r['rateLimitsByLimitId'];
  const snapshot = byId && typeof byId === 'object' && 'codex' in byId && byId.codex ? byId.codex : r['rateLimits'];
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  const snake: Record<string, unknown> = { rate_limit_reached_type: s['rateLimitReachedType'] };
  for (const key of ['primary', 'secondary']) {
    const w = s[key];
    if (!w || typeof w !== 'object') continue;
    const v = w as Record<string, unknown>;
    snake[key] = { used_percent: v['usedPercent'], window_minutes: v['windowDurationMins'], resets_at: v['resetsAt'] };
  }
  const quota = codexQuota(snake, at);
  const resetCredits = codexResetCredits(r['rateLimitResetCredits']);
  const extraUsage = codexExtraUsage(s['credits']);
  return quota ? { ...quota, ...(resetCredits ? { resetCredits } : {}), ...(extraUsage ? { extraUsage } : {}) } : null;
}

/** 即時額度查詢逾時；app-server 要連後端，網路差時不能卡住啟動或重新整理。 */
const QUOTA_TIMEOUT_MS = 15_000;

/** 以 `{command} {quotaArgs}`（app-server）查帳號目前額度：initialize → account/rateLimits/read，拿到就結束子行程。 */
export async function fetchCodexQuota(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = QUOTA_TIMEOUT_MS): Promise<QuotaEvent | null> {
  const exe = await findExecutable(command, env);
  if (!exe) throw new Error('CLI executable not found');
  const { promise, resolve, reject } = Promise.withResolvers<QuotaEvent | null>();
  const child = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  const closed = Promise.withResolvers<void>();
  child.once('close', () => closed.resolve());
  const timer = setTimeout(() => reject(new Error('quota query timed out')), timeoutMs);
  let buffer = '';
  child.on('error', reject);
  child.on('close', () => reject(new Error('app-server exited')));
  child.stdin.on('error', () => { /* 子行程已結束：由 close 處理。 */ });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { reject(new Error('quota response too large')); return; }
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      // `null`, numbers or arrays are valid JSON but no protocol message; touching `.id` on null would throw in this
      // stream callback and end the whole process.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const msg = parsed as { id?: unknown; result?: unknown; error?: unknown };
      if (msg.id === 1 && !msg.error) {
        child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n${JSON.stringify({ method: 'account/rateLimits/read', id: 2 })}\n`);
      } else if (msg.id === 1) {
        reject(new Error('initialize failed'));
      } else if (msg.id === 2) {
        if (msg.error) reject(new Error('rateLimits/read failed'));
        // This runs in a stream callback: an exception here would not reach the awaiting caller but end the process.
        else try { resolve(codexAppServerQuota(msg.result, new Date().toISOString())); } catch (error) { reject(error); }
      }
    }
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'yumeewade', title: null, version: '1' }, capabilities: null } })}\n`);
  try { return await promise; }
  finally {
    clearTimeout(timer);
    const terminated = Promise.withResolvers<void>();
    const cancel = terminateTree(child, () => terminated.resolve());
    try { await Promise.race([closed.promise, terminated.promise]); }
    finally { cancel(); }
  }
}

/** rollout 檔尾端最後一筆帶 rate_limits 的事件。 */
async function rolloutQuota(file: string): Promise<QuotaEvent | null> {
  const handle = await fs.open(file, 'r');
  let text: string;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    text = buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"rate_limits"')) continue;
    try {
      const row = JSON.parse(lines[i]!) as { timestamp?: unknown; payload?: { rate_limits?: unknown } };
      const at = typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString();
      const quota = codexQuota(row.payload?.rate_limits, at);
      if (quota) return quota;
    } catch { /* 被截斷的第一行或壞行，往前找。 */ }
  }
  return null;
}

async function namesDesc(dir: string, pattern: RegExp): Promise<string[]> {
  try { return (await fs.readdir(dir)).filter(name => pattern.test(name)).sort().reverse(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Codex 把每回合的 rate_limits 寫進 `{home}/sessions/YYYY/MM/DD/rollout-{時間}-{thread}.jsonl`（exec --json 不輸出額度）。
 * 給 thread 時找該會話的檔（resume 會追加到原檔，所以要往舊日期翻）；不給則在最新幾個檔中取時間最新的一筆——
 * 前一天建立、今天 resume 的會話排在後面，但它追加的回報可能比較新的檔更晚。
 */
export async function readCodexQuota(home: string, thread?: string): Promise<QuotaEvent | null> {
  const root = path.join(home, 'sessions');
  let checked = 0;
  let latest: QuotaEvent | null = null;
  for (const year of await namesDesc(root, /^\d{4}$/u)) {
    for (const month of await namesDesc(path.join(root, year), /^\d{2}$/u)) {
      for (const day of await namesDesc(path.join(root, year, month), /^\d{2}$/u)) {
        const dir = path.join(root, year, month, day);
        for (const name of await namesDesc(dir, /^rollout-.*\.jsonl$/u)) {
          if (thread) {
            if (name.endsWith(`-${thread}.jsonl`)) return rolloutQuota(path.join(dir, name));
            continue;
          }
          const quota = await rolloutQuota(path.join(dir, name));
          if (quota && (!latest || Date.parse(quota.at) > Date.parse(latest.at))) latest = quota;
          if (++checked >= LATEST_ROLLOUTS) return latest;
        }
      }
    }
  }
  return latest;
}

// exec 回合結束才給實際用量；測量整個回合的平均（包含等待／工具），不冒充即時解碼速度。
export function createCodexParser(onEvent: (ev: CliEvent) => void, now: () => number = Date.now): (obj: Record<string, unknown>) => void {
  let streamed = '';
  let failed = false;
  const runId = randomUUID();
  let started: number | null = null;
  const commands = new Set<string>();
  const appendText = (text: string) => {
    const delta = (streamed && !streamed.endsWith('\n') ? '\n\n' : '') + text;
    streamed += delta;
    onEvent({ type: 'delta', text: delta });
  };
  return (obj) => {
    switch (obj['type']) {
      case 'thread.started':
        if (typeof obj['thread_id'] === 'string') onEvent({ type: 'session', id: obj['thread_id'] });
        return;
      case 'turn.started':
        started = now();
        failed = false;
        return;
      case 'item.started':
      case 'item.completed': {
        const item = obj['item'];
        if (!item || typeof item !== 'object') return;
        const it = item as Record<string, unknown>;
        if (it['type'] === 'command_execution' && typeof it['command'] === 'string') {
          const id = typeof it['id'] === 'string' ? it['id'] : undefined;
          if (!id || !commands.has(id)) {
            onEvent({ type: 'tool', text: `command: ${it['command']}` });
            if (id) commands.add(id);
          }
        } else if (obj['type'] === 'item.completed') {
          if (it['type'] === 'agent_message' && typeof it['text'] === 'string') appendText(it['text']);
          else if (it['type'] === 'file_change' && Array.isArray(it['changes'])) {
            const paths = it['changes'].flatMap((c: unknown) => c && typeof c === 'object' && 'path' in c && typeof c.path === 'string' ? [c.path] : []);
            onEvent({ type: 'tool', text: `file_change: ${paths.join(', ')}` });
          } else if (it['type'] === 'error') {
            onEvent({ type: 'tool', text: `warning: ${String(it['message'] ?? '')}` });
          }
        }
        return;
      }
      case 'turn.completed':
        {
          const value = obj['usage'];
          if (value && typeof value === 'object') {
            const u = value as Record<string, unknown>;
            const input = u['input_tokens'];
            const output = u['output_tokens'];
            const cached = u['cached_input_tokens'];
            if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
              const at = now();
              const spanMs = started === null ? 0 : at - started;
              if (!failed && Number.isFinite(spanMs) && spanMs > 0) {
                onEvent({ type: 'tokens', runId, count: output, spanMs, at });
              }
            }
            if (typeof input === 'number' && Number.isFinite(input) && input >= 0 &&
                typeof output === 'number' && Number.isFinite(output) && output >= 0) {
              onEvent({ type: 'usage', usage: {
                input, output,
                ...(typeof cached === 'number' && Number.isFinite(cached) && cached >= 0 ? { cached } : {}),
              } });
            }
          }
        }
        started = null;
        if (!failed) onEvent({ type: 'result', text: streamed.trim() });
        return;
      case 'turn.failed':
      case 'error': {
        failed = true;
        started = null;
        const err = obj['error'];
        const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(obj['message'] ?? obj['type']);
        onEvent({ type: 'error', reason: msg.slice(0, 200) });
        return;
      }
    }
    const legacy = obj['msg'];
    if (!legacy || typeof legacy !== 'object') return;
    const m = legacy as Record<string, unknown>;
    switch (m['type']) {
      case 'session_configured':
        if (typeof m['session_id'] === 'string') onEvent({ type: 'session', id: m['session_id'] });
        break;
      case 'agent_message':
        if (typeof m['message'] === 'string') appendText(m['message']);
        break;
      case 'exec_command_begin':
        onEvent({ type: 'tool', text: `command: ${Array.isArray(m['command']) ? m['command'].join(' ') : String(m['command'] ?? '')}` });
        break;
      case 'task_complete':
        if (!failed) onEvent({ type: 'result', text: streamed.trim() });
        break;
      case 'error':
        failed = true;
        onEvent({ type: 'error', reason: String(m['message'] ?? 'error').slice(0, 200) });
        break;
    }
  };
}

/** `/fast` lives in the App, not the protocol: app-server keeps the tier only for the life of one process. */
const FAST_COMMAND: SlashCommand = { name: 'fast', description: 'Toggle Fast mode for this task (faster, higher usage)', argumentHint: '[on|off|status]' };
const FAST_ARGUMENTS: Record<string, FastChange> = { '': 'toggle', on: 'on', off: 'off', status: 'status' };

export class CodexCliProvider implements CliProvider {
  readonly name = 'codex';
  readonly dangerous: boolean;
  readonly readonlyEnforcement = 'native-sandbox' as const;
  get supportsReadonly(): boolean { return readonlyConfigured('codex', this.cfg) && (process.platform === 'darwin' || process.platform === 'linux'); }
  get supportsApprovals(): boolean { return (this.cfg.mode ?? 'app-server') === 'app-server'; }
  private readonly cfg: CliCommandConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;

  constructor(cfg: CliCommandConfig, envPassthrough: string[], env?: NodeJS.ProcessEnv) {
    this.cfg = cfg;
    this.dangerous = cfg.fullAccess;
    this.env = env ?? minimalEnv(envPassthrough);
    this.home = this.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
  }

  async available(): Promise<boolean> { return (await findExecutable(this.cfg.command, this.env)) !== null; }

  /** 查詢指定帳戶；即時查詢失敗不得拿舊 rollout 偽裝成恢復。 */
  async quota(configDir?: string): Promise<QuotaEvent | null> {
    const env = configDir ? { ...this.env, CODEX_HOME: configDir } : this.env;
    if (this.cfg.quotaArgs.length) return fetchCodexQuota(this.cfg.command, this.cfg.quotaArgs, env);
    return readCodexQuota(configDir ?? this.home);
  }

  private appEnv(configDir?: string): NodeJS.ProcessEnv { return configDir ? { ...this.env, CODEX_HOME: configDir } : this.env; }

  private async skills(cwd: string, configDir?: string): Promise<CodexSkill[]> {
    return codexSkills(await codexAppServerRequest(this.cfg, this.appEnv(configDir), cwd, 'skills/list', { cwds: [cwd] }));
  }

  async commands(cwd: string, configDir?: string) {
    const prompts = (await codexPrompts(configDir ?? this.home)).map(({ body: _body, ...command }) => command);
    if (!this.supportsApprovals) return prompts;
    let skills: CodexSkill[];
    try { skills = await this.skills(cwd, configDir); } catch { throw new AppError('unavailable'); }
    const builtins: SlashCommand[] = [...CODEX_APP_COMMANDS.values()].map(({ name, description, argumentHint }) => ({ name, description, ...(argumentHint ? { argumentHint } : {}) }));
    const taken = new Set([...builtins.map(command => command.name), FAST_COMMAND.name, ...prompts.map(command => command.name)]);
    // A skill is invoked by its own name, as `$name` is in the TUI; built-ins and custom prompts keep theirs.
    const invocable = skills.filter(skill => !taken.has(skill.name) && !EXCLUDED_COMMANDS.has(skill.name) && /^[\p{L}\p{N}_:./-]{1,150}$/u.test(skill.name))
      .map(skill => ({ name: skill.name, description: skill.description.slice(0, 2000) }));
    return [...builtins, FAST_COMMAND, ...prompts, ...invocable].sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveCommand(text: string, cwd: string, configDir?: string): Promise<ResolvedCommand> {
    const name = slashName(text);
    if (!name || EXCLUDED_COMMANDS.has(name)) throw new AppError('bad_request', 'slash_unsupported');
    const argument = text.trim().slice(name.length + 1).trim();
    if (this.supportsApprovals) {
      if (name === 'fast') {
        if (!Object.hasOwn(FAST_ARGUMENTS, argument.toLowerCase())) throw new AppError('bad_request', 'slash_unsupported');
        return { text: text.trim(), native: true, fast: FAST_ARGUMENTS[argument.toLowerCase()]! };
      }
      const builtin = CODEX_APP_COMMANDS.get(name);
      if (builtin) {
        if (!codexCommandArgument(builtin, argument)) throw new AppError('bad_request', 'slash_unsupported');
        return { text: text.trim(), native: true, ...(builtin.standalone(argument) ? { standalone: true } : {}) };
      }
    }
    const prompt = (await codexPrompts(configDir ?? this.home)).find(command => command.name === name);
    if (prompt) return { text: expandCodexPrompt(prompt.body, text.trimStart().slice(name.length + 1).trim()), native: false };
    if (this.supportsApprovals) {
      let skills: CodexSkill[];
      try { skills = await this.skills(cwd, configDir); } catch { throw new AppError('unavailable'); }
      if (skills.some(skill => skill.name === name)) return { text: text.trim(), native: true };
    }
    throw new AppError('bad_request', 'slash_unsupported');
  }

  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    if (opts.readonly && !this.supportsReadonly) throw new AppError('bad_request', 'cli_unsupported');
    if (!opts.readonly && (this.cfg.mode ?? 'app-server') === 'app-server') return codexAppServerRun(this.cfg, opts, this.appEnv(opts.configDir), onEvent);
    let completed = false;
    let failed = false;
    let thread = opts.resumeId;
    const run = runLineProcess(
      {
        command: this.cfg.command, args: codexArgs(this.cfg, opts),
        cwd: opts.cwd, env: opts.configDir ? { ...this.env, CODEX_HOME: opts.configDir } : this.env, prompt: opts.prompt, label: 'codex',
      },
      createCodexParser(ev => {
        if (ev.type === 'session') thread = ev.id;
        if (ev.type === 'result') completed = true;
        if (ev.type === 'error') failed = true;
        onEvent(ev);
      }),
    );
    return {
      stop: run.stop,
      done: run.done.then(async outcome => {
        // 額度不論成敗都更新；撞到上限的失敗回合正是最需要看額度的時候。
        if (thread) {
          try {
            const quota = await readCodexQuota(opts.configDir ?? this.home, thread);
            if (quota) onEvent(quota);
          } catch { /* 讀不到 CLI 紀錄只是少了額度顯示，不影響回合結果。 */ }
        }
        if (!outcome.ok || outcome.stopped) return outcome;
        if (failed) return { ...outcome, ok: false, reason: 'turn failed' };
        if (completed) return outcome;
        onEvent({ type: 'error', reason: 'no result event' });
        return { ...outcome, ok: false, reason: 'no result event' };
      }),
    };
  }
}
