// Claude stream-json adapter；工具與問題獨立於回答文字。
import type { CliCommandConfig } from '../shared/config.ts';
import { randomUUID } from 'node:crypto';
import type { Ask, QuotaWindow, TurnUsage } from '../shared/types.ts';
import { findExecutable, minimalEnv, runLineProcess } from './process.ts';
import { readClaudeToken } from './claude-credentials.ts';
import type { CliEvent, CliProvider, CliRun, SendOptions } from './provider.ts';
import { claudeCommands, slashName } from './commands.ts';
import { AppError } from '../shared/errors.ts';

export function claudeArgs(cfg: CliCommandConfig, opts: SendOptions): string[] {
  const args = [...((opts.fullAccess ?? cfg.fullAccess) ? cfg.fullAccessArgs : cfg.safeArgs), ...cfg.baseArgs];
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
    const resets = 'resetsAt' in value && typeof value.resetsAt === 'number' && value.resetsAt > 0 ? value.resetsAt : null;
    windows.push({
      label: key.replace(/^five_hour/u, '5h').replace(/^seven_day/u, '7d').replaceAll('_', ' '),
      usedPercent: Math.round(Math.min(1, Math.max(0, value.utilization)) * 1000) / 10,
      resetsAt: resets === null ? null : new Date(resets * 1000).toISOString(),
    });
  }
  const limited = i['status'] === 'rejected';
  return windows.length || limited ? { windows, limited } : null;
}

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
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

/** 向 Anthropic 查帳號目前的 5 小時／7 天用量；憑證只用於這個請求，不寫日誌。 */
export async function fetchClaudeQuota(env: NodeJS.ProcessEnv, timeoutMs = 15_000, url = OAUTH_USAGE_URL, readToken = readClaudeToken): Promise<{ type: 'quota'; windows: QuotaWindow[]; limited: boolean; at: string } | null> {
  const token = await readToken(env);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
  const quota = claudeOauthQuota(await res.json());
  return quota ? { type: 'quota', ...quota, at: new Date().toISOString() } : null;
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
  let generating: number | null = null;
  let messageUsage: Record<string, unknown> = {};
  let output = -1;
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
        if (e['type'] === 'message_start') {
          sawStream = false;
          generating = now();
          output = -1;
          const message = e['message'];
          const usage = message && typeof message === 'object' && 'usage' in message ? message.usage : undefined;
          messageUsage = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
        }
        if (e['type'] === 'message_delta') {
          const value = e['usage'];
          if (value && typeof value === 'object') messageUsage = { ...messageUsage, ...value };
          const usage = parseUsage(messageUsage);
          if (usage) onEvent({ type: 'usage', usage });
          const exact = value && typeof value === 'object' && 'output_tokens' in value ? value.output_tokens : undefined;
          const at = now();
          const spanMs = generating === null ? 0 : at - generating;
          // output_tokens 是本訊息累計，已包含思考與工具輸入；不另外加 thinking_tokens。
          if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0 && exact > output &&
              Number.isFinite(spanMs) && spanMs > 0) {
            output = exact;
            onEvent({ type: 'tokens', runId, count: exact, spanMs, at });
          }
        }
        if (e['type'] === 'message_stop') generating = null;
        if (e['type'] === 'content_block_delta') {
          const delta = e['delta'];
          if (!delta || typeof delta !== 'object') return;
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
        for (const block of msg.content as unknown[]) {
          if (!block || typeof block !== 'object' || !('type' in block)) continue;
          if (block.type === 'tool_use') handleTool(block as Record<string, unknown>);
          else if (!sawStream && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
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
        generating = null;
        const usage = parseUsage(obj['usage']);
        if (usage) onEvent({ type: 'usage', usage });
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
  private readonly cfg: CliCommandConfig;
  private readonly env: NodeJS.ProcessEnv;

  constructor(cfg: CliCommandConfig, envPassthrough: string[], env?: NodeJS.ProcessEnv) {
    this.cfg = cfg;
    this.dangerous = cfg.fullAccess;
    this.env = env ?? minimalEnv(envPassthrough);
  }

  async available(): Promise<boolean> { return (await findExecutable(this.cfg.command, this.env)) !== null; }

  /** 帳號目前的 5 小時／7 天用量（讀 CLI 存的 OAuth 憑證查詢）；失敗由呼叫端記日誌，額度仍會隨回合中的 rate_limit_event 更新。 */
  quota(configDir?: string): Promise<Extract<CliEvent, { type: 'quota' }> | null> {
    return fetchClaudeQuota(configDir ? { ...this.env, CLAUDE_CONFIG_DIR: configDir } : this.env);
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
    const run = runLineProcess(
      {
        command: this.cfg.command, args: claudeArgs(this.cfg, opts),
        cwd: opts.cwd, env: opts.configDir ? { ...this.env, CLAUDE_CONFIG_DIR: opts.configDir } : this.env, prompt: opts.slashCommand ?? opts.prompt + imagePrompt, label: 'claude',
      },
      createClaudeParser(ev => {
        if (ev.type === 'result') completed = true;
        if (ev.type === 'error') failed = true;
        onEvent(ev);
      }),
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
