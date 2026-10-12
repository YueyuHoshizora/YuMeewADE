// Claude stream-json adapter；工具與問題獨立於回答文字。
import type { CliCommandConfig } from '../shared/config.ts';
import { randomUUID } from 'node:crypto';
import type { Ask, CloudCredits, ExtraUsage, QuotaWindow, ResetCredit, ResetCredits, TurnUsage } from '../shared/types.ts';
import { captureCommand, findExecutable, minimalEnv, runLineProcess } from './process.ts';
import { readClaudeToken } from './claude-credentials.ts';
import { quotaTime, type CliEvent, type CliProvider, type CliRun, type SendOptions } from './provider.ts';
import { claudeCommands, slashName } from './commands.ts';
import { AppError } from '../shared/errors.ts';
import { readonlyConfigured, reviewArgs } from './readonly.ts';

export function claudeArgs(cfg: CliCommandConfig, opts: SendOptions): string[] {
  const args = opts.readonly ? reviewArgs('claude', cfg, opts) : [...((opts.fullAccess ?? cfg.fullAccess) ? cfg.fullAccessArgs : cfg.safeArgs), ...cfg.baseArgs];
  if (!opts.readonly && !(opts.fullAccess ?? cfg.fullAccess)) args.push(...(cfg.approvalArgs ?? []));
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.resumeId) args.push('--resume', opts.resumeId);
  for (const d of opts.addDirs ?? []) args.push('--add-dir', d);
  if (opts.slashCommand) args.push('--append-system-prompt', opts.prompt);
  return args;
}

/** `rate_limit_event.rate_limit_info` → 額度窗口；utilization 為 0–1、resetsAt 為秒。認不得的格式回 null。 */
export function claudeQuota(info: unknown): { windows: QuotaWindow[]; limited: boolean } | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  const unified = i['unifiedWindows'];
  // 新版 CLI 一次給所有窗口；舊版只給觸發中的那一個。
  const entries: [string, unknown][] = unified && typeof unified === 'object'
    ? Object.entries(unified)
    : typeof i['rateLimitType'] === 'string' ? [[i['rateLimitType'], i]] : [];
  const windows: QuotaWindow[] = [];
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object' || !('utilization' in value) || typeof value.utilization !== 'number') continue;
    const resets = 'resetsAt' in value ? quotaTime(value.resetsAt) : null;
    windows.push({
      label: key.replace(/^five_hour/u, '5h').replace(/^seven_day/u, '7d').replaceAll('_', ' '),
      usedPercent: Math.round(Math.min(1, Math.max(0, value.utilization)) * 1000) / 10,
      resetsAt: resets,
    });
  }
  const limited = i['status'] === 'rejected';
  return windows.length || limited ? { windows, limited } : null;
}

// cedar_ember=1 讓回應附上 `cedar_ember`（可用的限額重置）；伺服器依 User-Agent 判斷來源，沒帶 claude-cli 版本會回 surface 不符且無資料。
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1';
const MAX_RESET_CREDITS = 20;
const USAGE_WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d opus', seven_day_sonnet: '7d sonnet' };

/** `/api/oauth/usage` 的回應（utilization 已是 0–100 百分比、resets_at 為 ISO）→ 額度窗口；只收已知的窗口，未知欄位忽略。 */
export function claudeOauthQuota(body: unknown): { windows: QuotaWindow[]; limited: boolean } | null {
  if (!body || typeof body !== 'object') return null;
  const windows: QuotaWindow[] = [];
  for (const [key, label] of Object.entries(USAGE_WINDOWS)) {
    const w = (body as Record<string, unknown>)[key];
    if (!w || typeof w !== 'object' || !('utilization' in w) || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
    const resets = 'resets_at' in w && typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    windows.push({
      label,
      usedPercent: Math.round(Math.min(100, Math.max(0, w.utilization)) * 10) / 10,
      resetsAt: Number.isNaN(resets) ? null : new Date(resets).toISOString(),
    });
  }
  return windows.length ? { windows, limited: windows.some(w => w.usedPercent >= 100) } : null;
}

/** `cedar_ember.grants`（限額重置的發放：label、resets_left、ends_at）→ 重置券；每張剩餘次數展開成一筆，已過期或沒有剩餘者略過。 */
export function claudeResetCredits(body: unknown, now = Date.now()): ResetCredits | undefined {
  const cedar = body && typeof body === 'object' ? (body as Record<string, unknown>)['cedar_ember'] : undefined;
  const grants = cedar && typeof cedar === 'object' ? (cedar as Record<string, unknown>)['grants'] : undefined;
  if (!Array.isArray(grants)) return undefined;
  const credits: ResetCredit[] = [];
  let availableCount = 0;
  for (const row of grants) {
    if (!row || typeof row !== 'object') continue;
    const grant = row as Record<string, unknown>;
    const left = grant['resets_left'];
    if (typeof left !== 'number' || !Number.isSafeInteger(left) || left <= 0) continue;
    const ends = typeof grant['ends_at'] === 'string' ? Date.parse(grant['ends_at']) : NaN;
    if (!Number.isNaN(ends) && ends <= now) continue;
    availableCount += left;
    for (let i = 0; i < left && credits.length < MAX_RESET_CREDITS; i++) {
      credits.push({
        title: typeof grant['label'] === 'string' && grant['label'] ? grant['label'].slice(0, 80) : null,
        expiresAt: Number.isNaN(ends) ? null : new Date(ends).toISOString(),
      });
    }
  }
  credits.sort((a, b) => (a.expiresAt ?? '9').localeCompare(b.expiresAt ?? '9'));
  return { availableCount, credits };
}

function minorUnits(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 用量端點的 `extra_usage` → 餘額＝月上限－已用（不低於 0）；金額單位為 `currency` 的最小單位（美元為 cents）。
 * null／缺少（方案沒有）、未啟用或沒有上限都視為餘額 0；格式錯誤整體忽略。
 */
export function claudeExtraUsage(body: unknown): ExtraUsage | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const extra = (body as Record<string, unknown>)['extra_usage'];
  if (extra === null || extra === undefined) return { unlimited: false, currency: 'USD', balance: 0 };
  if (typeof extra !== 'object') return undefined;
  const e = extra as Record<string, unknown>;
  if (typeof e['is_enabled'] !== 'boolean') return undefined;
  const currency = typeof e['currency'] === 'string' && /^[A-Za-z]{3}$/.test(e['currency']) ? e['currency'].toUpperCase() : 'USD';
  const limit = minorUnits(e['monthly_limit']);
  const used = minorUnits(e['used_credits']) ?? 0;
  return { unlimited: false, currency, balance: e['is_enabled'] && limit !== null ? Math.max(0, limit - used) : 0 };
}

/**
 * 用量端點的 `iguana_necktie`（雲端工作階段限期點數：limit_dollars／used_dollars／remaining_dollars／resets_at）→ 餘額（cents）與到期時間。
 * null／缺少、已到期都視為 $0 且無到期；格式錯誤整體忽略。
 */
export function claudeCloudCredits(body: unknown, now = Date.now()): CloudCredits | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = 'iguana_necktie' in body ? body.iguana_necktie : undefined;
  const none: CloudCredits = { balance: 0, expiresAt: null };
  if (raw === null || raw === undefined) return none;
  if (typeof raw !== 'object' || !('remaining_dollars' in raw)) return undefined;
  const left = raw.remaining_dollars;
  if (typeof left !== 'number' || !Number.isFinite(left) || left < 0) return undefined;
  const ends = 'resets_at' in raw && typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : NaN;
  if (!Number.isNaN(ends) && ends <= now) return none;
  return { balance: Math.round(left * 100), expiresAt: Number.isNaN(ends) ? null : new Date(ends).toISOString() };
}

const clientVersions = new Map<string, Promise<string | undefined>>();

/** 本機 `claude --version` 的版本號（僅成功時快取），用於 User-Agent；取不到就回 undefined。 */
export function claudeClientVersion(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const cached = clientVersions.get(command);
  if (cached) return cached;
  const pending = captureCommand({ command, args: ['--version'], env, timeoutMs: 10_000 })
    .then(result => result.ok ? /\b\d+\.\d+\.\d+\b/.exec(result.stdout)?.[0] : undefined, () => undefined)
    .then(version => { if (!version) clientVersions.delete(command); return version; });
  clientVersions.set(command, pending);
  return pending;
}

/** 向 Anthropic 查帳號目前的 5 小時／7 天用量與重置券；憑證只用於這個請求，不寫日誌。 */
export async function fetchClaudeQuota(env: NodeJS.ProcessEnv, timeoutMs = 15_000, url = OAUTH_USAGE_URL, readToken = readClaudeToken, clientVersion?: string): Promise<{ type: 'quota'; windows: QuotaWindow[]; limited: boolean; at: string; resetCredits?: ResetCredits; extraUsage?: ExtraUsage; cloudCredits?: CloudCredits } | null> {
  const token = await readToken(env);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', ...(clientVersion ? { 'User-Agent': `claude-cli/${clientVersion} (external, cli)` } : {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
  const body: unknown = await res.json();
  const quota = claudeOauthQuota(body);
  const resetCredits = claudeResetCredits(body);
  const extraUsage = claudeExtraUsage(body);
  const cloudCredits = claudeCloudCredits(body);
  return quota ? { type: 'quota', ...quota, at: new Date().toISOString(), ...(resetCredits ? { resetCredits } : {}), ...(extraUsage ? { extraUsage } : {}), ...(cloudCredits ? { cloudCredits } : {}) } : null;
}

function parseUsage(value: unknown): TurnUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const u = value as Record<string, unknown>;
  const input = u['input_tokens'];
  const output = u['output_tokens'];
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 ||
      typeof output !== 'number' || !Number.isFinite(output) || output < 0) return;
  const creation = u['cache_creation_input_tokens'];
  const cached = u['cache_read_input_tokens'];
  return {
    input: input + (typeof creation === 'number' && Number.isFinite(creation) && creation >= 0 ? creation : 0),
    output,
    ...(typeof cached === 'number' && Number.isFinite(cached) && cached >= 0 ? { cached } : {}),
  };
}

export function createClaudeParser(onEvent: (ev: CliEvent) => void, now: () => number = Date.now): (obj: Record<string, unknown>) => void {
  let streamed = '';
  let sawStream = false;
  let sessionId = '';
  const runId = randomUUID();
  let sampleIndex = 0;
  const messages = new Map<string, { runId: string; started: number; usage: Record<string, unknown>; output: number }>();
  const tools = new Set<string>();
  const handleTool = (block: Record<string, unknown>) => {
    const name = block['name'];
    if (typeof name !== 'string') return;
    const id = block['id'];
    if (typeof id === 'string' && tools.has(id)) return;
    if (name === 'AskUserQuestion') {
      const input = block['input'];
      if (!input || typeof input !== 'object' || !('questions' in input) || !Array.isArray(input.questions)) return;
      const asks: Ask[] = [];
      for (const q of input.questions as unknown[]) {
        if (!q || typeof q !== 'object' || !('question' in q) || typeof q.question !== 'string') continue;
        const options = 'options' in q && Array.isArray(q.options) ? q.options.flatMap((o: unknown) => {
          if (typeof o === 'string') return [o];
          return o && typeof o === 'object' && 'label' in o && typeof o.label === 'string' ? [o.label] : [];
        }) : [];
        asks.push({ question: q.question, options, multi: 'multiSelect' in q && q.multiSelect === true });
      }
      if (!asks.length) return;
      onEvent({ type: 'asks', asks });
    } else {
      const input = block['input'];
      let summary: unknown;
      if (input && typeof input === 'object') {
        if (['Read', 'Edit', 'Write'].includes(name) && 'file_path' in input) summary = input.file_path;
        else if (name === 'Bash' && 'command' in input) summary = input.command;
        else if (['Grep', 'Glob'].includes(name) && 'pattern' in input) summary = input.pattern;
      }
      onEvent({ type: 'tool', text: typeof summary === 'string' && summary ? `${name}: ${summary.slice(0, 160)}` : name });
    }
    if (typeof id === 'string') tools.add(id);
  };
  return (obj) => {
    const sid = obj['session_id'];
    if (obj['parent_tool_use_id'] == null && typeof sid === 'string' && sid && sid !== sessionId) {
      sessionId = sid;
      onEvent({ type: 'session', id: sid });
    }
    switch (obj['type']) {
      case 'stream_event': {
        const ev = obj['event'];
        if (!ev || typeof ev !== 'object') return;
        const e = ev as Record<string, unknown>;
        // Nested agent streams can interleave with the main stream; each has its own message clock. Their text is the
        // subagent's own work, handed back to the main agent as a tool result, never part of the reply shown to the human.
        const key = typeof obj['parent_tool_use_id'] === 'string' ? obj['parent_tool_use_id'] : '';
        if (e['type'] === 'message_start') {
          if (!key) sawStream = false;
          const message = e['message'];
          const usage = message && typeof message === 'object' && 'usage' in message ? message.usage : undefined;
          messages.set(key, {
            runId: `${runId}:${++sampleIndex}`, started: now(), output: -1,
            usage: usage && typeof usage === 'object' ? { ...usage as Record<string, unknown> } : {},
          });
        }
        if (e['type'] === 'message_delta') {
          const value = e['usage'];
          const sample = messages.get(key);
          if (sample && value && typeof value === 'object') Object.assign(sample.usage, value);
          const usage = parseUsage(sample?.usage ?? value);
          if (usage) onEvent({ type: 'usage', usage });
          const exact = value && typeof value === 'object' && 'output_tokens' in value ? value.output_tokens : undefined;
          const at = now();
          const spanMs = sample ? at - sample.started : 0;
          // output_tokens 是本訊息累計，已包含思考與工具輸入；不另外加 thinking_tokens。
          if (sample && typeof exact === 'number' && Number.isFinite(exact) && exact >= 0 && exact > sample.output &&
              Number.isFinite(spanMs) && spanMs > 0) {
            sample.output = exact;
            onEvent({ type: 'tokens', runId: sample.runId, count: exact, spanMs, at });
          }
        }
        if (e['type'] === 'message_stop') messages.delete(key);
        if (e['type'] === 'content_block_delta') {
          const delta = e['delta'];
          if (key || !delta || typeof delta !== 'object') return;
          if ('type' in delta && delta.type === 'text_delta' && 'text' in delta && typeof delta.text === 'string') {
            sawStream = true;
            streamed += delta.text;
            onEvent({ type: 'delta', text: delta.text });
          }
        }
        return;
      }
      case 'assistant': {
        const msg = obj['message'];
        if (!msg || typeof msg !== 'object' || !('content' in msg) || !Array.isArray(msg.content)) return;
        // A subagent's tools still show as activity; its text stays out of the main reply (see stream_event).
        const nested = obj['parent_tool_use_id'] != null;
        for (const block of msg.content as unknown[]) {
          if (!block || typeof block !== 'object' || !('type' in block)) continue;
          if (block.type === 'tool_use') handleTool(block as Record<string, unknown>);
          else if (!nested && !sawStream && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
            streamed += block.text;
            onEvent({ type: 'delta', text: block.text });
          }
        }
        return;
      }
      case 'rate_limit_event': {
        const quota = claudeQuota(obj['rate_limit_info']);
        if (quota) onEvent({ type: 'quota', ...quota, at: new Date(now()).toISOString() });
        return;
      }
      case 'result': {
        messages.clear();
        const usage = parseUsage(obj['usage']);
        if (usage) onEvent({ type: 'usage', usage: { ...usage, ...(typeof obj['total_cost_usd'] === 'number' && Number.isFinite(obj['total_cost_usd']) && obj['total_cost_usd'] >= 0 ? { claudeUsd: obj['total_cost_usd'] } : {}) } });
        const isError = obj['is_error'] === true || (typeof obj['subtype'] === 'string' && obj['subtype'] !== 'success');
        const text = typeof obj['result'] === 'string' ? obj['result'] : '';
        if (isError) onEvent({ type: 'error', reason: `result ${String(obj['subtype'])}: ${text.slice(0, 200)}` });
        else onEvent({ type: 'result', text: streamed.trim() || text });
        return;
      }
    }
  };
}

export class ClaudeCliProvider implements CliProvider {
  readonly name = 'claude';
  readonly dangerous: boolean;
  get supportsApprovals(): boolean { return (this.cfg.approvalArgs ?? []).includes('--permission-prompt-tool'); }
  readonly readonlyEnforcement = 'tool-allowlist' as const;
  get supportsReadonly(): boolean { return readonlyConfigured('claude', this.cfg); }
  private readonly cfg: CliCommandConfig;
  private readonly env: NodeJS.ProcessEnv;

  constructor(cfg: CliCommandConfig, envPassthrough: string[], env?: NodeJS.ProcessEnv) {
    this.cfg = cfg;
    this.dangerous = cfg.fullAccess;
    this.env = env ?? minimalEnv(envPassthrough);
  }

  async available(): Promise<boolean> { return (await findExecutable(this.cfg.command, this.env)) !== null; }

  /** 帳號目前的 5 小時／7 天用量（讀 CLI 存的 OAuth 憑證查詢）；失敗由呼叫端記日誌，額度仍會隨回合中的 rate_limit_event 更新。 */
  async quota(configDir?: string): Promise<Extract<CliEvent, { type: 'quota' }> | null> {
    return fetchClaudeQuota(configDir ? { ...this.env, CLAUDE_CONFIG_DIR: configDir } : this.env, undefined, undefined, undefined, await claudeClientVersion(this.cfg.command, this.env));
  }

  commands(cwd: string, configDir?: string) {
    return claudeCommands(this.cfg.command, [...this.cfg.baseArgs, '--input-format', 'stream-json'], cwd,
      configDir ? { ...this.env, CLAUDE_CONFIG_DIR: configDir } : this.env);
  }

  async resolveCommand(text: string, cwd: string, configDir?: string) {
    const name = slashName(text);
    if (!name || !(await this.commands(cwd, configDir)).some(command => command.name === name)) {
      throw new AppError('bad_request', 'slash_unsupported');
    }
    return { text: text.trimStart(), native: true };
  }

  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    const imagePrompt = opts.images?.length ? `\n\n# 圖片附件\n請用 Read 工具查看以下圖片：\n${opts.images.join('\n')}` : '';
    let completed = false;
    let failed = false;
    const approvals = !opts.readonly && !(opts.fullAccess ?? this.cfg.fullAccess) && this.supportsApprovals;
    const prompt = opts.slashCommand ?? opts.prompt + imagePrompt;
    const parser = createClaudeParser(ev => {
      if (ev.type === 'result') { completed = true; if (approvals) run.endInput(); }
      if (ev.type === 'error') failed = true;
      onEvent(ev);
    });
    const run = runLineProcess(
      {
        command: this.cfg.command, args: claudeArgs(this.cfg, opts),
        cwd: opts.cwd, env: opts.configDir ? { ...this.env, CLAUDE_CONFIG_DIR: opts.configDir } : this.env,
        prompt: approvals ? JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: opts.resumeId ?? '' }) + '\n' : prompt,
        keepInput: approvals, label: 'claude',
      },
      obj => {
        if (approvals && obj['type'] === 'control_request') {
          const request = obj['request'] as Record<string, unknown> | undefined;
          const id = obj['request_id'];
          if (typeof id !== 'string' || !request) return;
          if (request['subtype'] !== 'can_use_tool' || typeof request['tool_name'] !== 'string' || !request['input'] || typeof request['input'] !== 'object' || Array.isArray(request['input'])) {
            run.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: '不支援的控制請求' } }) + '\n');
            return;
          }
          const input = request['input'] as Record<string, unknown>;
          let answered = false;
          onEvent({ type: 'permission', id, tool: request['tool_name'], input, respond: allow => {
            if (answered) return;
            answered = true;
            run.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '使用者拒絕或核准已逾時' } } }) + '\n');
          } });
          return;
        }
        parser(obj);
      },
    );
    return {
      stop: run.stop,
      done: run.done.then(outcome => {
        if (!outcome.ok || outcome.stopped) return outcome;
        if (failed) return { ...outcome, ok: false, reason: 'result failed' };
        if (completed) return outcome;
        onEvent({ type: 'error', reason: 'no result event' });
        return { ...outcome, ok: false, reason: 'no result event' };
      }),
    };
  }
}
