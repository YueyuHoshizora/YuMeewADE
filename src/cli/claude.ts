// Claude stream-json adapter；工具與問題獨立於回答文字。
import type { CliCommandConfig } from '../shared/config.ts';
import type { Ask, QuotaWindow } from '../shared/types.ts';
import { findExecutable, minimalEnv, runLineProcess } from './process.ts';
import type { CliEvent, CliProvider, CliRun, SendOptions } from './provider.ts';

export function claudeArgs(cfg: CliCommandConfig, opts: SendOptions): string[] {
  const args = [...((opts.fullAccess ?? cfg.fullAccess) ? cfg.fullAccessArgs : cfg.safeArgs), ...cfg.baseArgs];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.resumeId) args.push('--resume', opts.resumeId);
  for (const d of opts.addDirs ?? []) args.push('--add-dir', d);
  return args;
}

/** 速度樣本太短（少量 token 或極短時間）時數字只是雜訊，不回報。 */
const MIN_SPEED_TOKENS = 10;
const MIN_SPEED_MS = 250;

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

export function createClaudeParser(onEvent: (ev: CliEvent) => void, now: () => number = Date.now): (obj: Record<string, unknown>) => void {
  let streamed = '';
  let sawStream = false;
  let sessionSent = false;
  /** 本則訊息第一個內容增量的時間；量的是生成速度，不含排隊與首字延遲。 */
  let generating: number | null = null;
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
    if (!sessionSent && typeof sid === 'string' && sid) {
      sessionSent = true;
      onEvent({ type: 'session', id: sid });
    }
    switch (obj['type']) {
      case 'stream_event': {
        const ev = obj['event'];
        if (!ev || typeof ev !== 'object') return;
        const e = ev as Record<string, unknown>;
        if (e['type'] === 'message_start') {
          sawStream = false;
          generating = null;
        }
        if (e['type'] === 'content_block_delta') generating ??= now();
        if (e['type'] === 'message_delta' && generating !== null) {
          const usage = e['usage'];
          const tokens = usage && typeof usage === 'object' && 'output_tokens' in usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
          const ms = now() - generating;
          generating = null;
          if (tokens >= MIN_SPEED_TOKENS && ms >= MIN_SPEED_MS) onEvent({ type: 'speed', tokensPerSecond: Math.round(tokens / (ms / 1000)) });
        }
        if (e['type'] === 'content_block_delta') {
          const delta = e['delta'];
          if (delta && typeof delta === 'object' && 'type' in delta && delta.type === 'text_delta' && 'text' in delta && typeof delta.text === 'string') {
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

  constructor(cfg: CliCommandConfig, envPassthrough: string[]) {
    this.cfg = cfg;
    this.dangerous = cfg.fullAccess;
    this.env = minimalEnv(envPassthrough);
  }

  async available(): Promise<boolean> { return (await findExecutable(this.cfg.command, this.env)) !== null; }

  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    const imagePrompt = opts.images?.length ? `\n\n# 圖片附件\n請用 Read 工具查看以下圖片：\n${opts.images.join('\n')}` : '';
    let completed = false;
    let failed = false;
    const run = runLineProcess(
      {
        command: this.cfg.command, args: claudeArgs(this.cfg, opts),
        cwd: opts.cwd, env: this.env, prompt: opts.prompt + imagePrompt, label: 'claude',
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
