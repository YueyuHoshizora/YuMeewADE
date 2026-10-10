// Codex --json adapter（含舊版 msg 事件）；工具不混入回答。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliCommandConfig } from '../shared/config.ts';
import type { QuotaWindow } from '../shared/types.ts';
import { findExecutable, minimalEnv, runLineProcess } from './process.ts';
import type { CliEvent, CliProvider, CliRun, SendOptions } from './provider.ts';

type QuotaEvent = Extract<CliEvent, { type: 'quota' }>;

/** rollout 檔只讀尾端；token_count 每回合寫一次，最後一筆一定在尾端附近。 */
const ROLLOUT_TAIL_BYTES = 512 * 1024;
/** 啟動時找「最近一次」額度最多翻幾個 rollout 檔。 */
const LATEST_ROLLOUTS = 5;

export function codexArgs(cfg: CliCommandConfig, opts: SendOptions): string[] {
  const args = [...cfg.baseArgs];
  // exec 子命令後放權限旗標；baseArgs 可由設定檔調整。
  args.splice(args[0] === 'exec' ? 1 : 0, 0, ...((opts.fullAccess ?? cfg.fullAccess) ? cfg.fullAccessArgs : cfg.safeArgs));
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
    const resets = 'resets_at' in w && typeof w.resets_at === 'number' && w.resets_at > 0 ? w.resets_at : null;
    windows.push({
      label: minutes <= 0 ? key : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`,
      usedPercent: Math.round(Math.min(100, Math.max(0, w.used_percent)) * 10) / 10,
      resetsAt: resets === null ? null : new Date(resets * 1000).toISOString(),
    });
  }
  const limited = l['rate_limit_reached_type'] !== null && l['rate_limit_reached_type'] !== undefined;
  return windows.length || limited ? { type: 'quota', windows, limited, at } : null;
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
 * 給 thread 時找該會話的檔（resume 會追加到原檔，所以要往舊日期翻）；不給則取最新幾個檔中最近的一筆。
 */
export async function readCodexQuota(home: string, thread?: string): Promise<QuotaEvent | null> {
  const root = path.join(home, 'sessions');
  let checked = 0;
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
          if (quota || ++checked >= LATEST_ROLLOUTS) return quota;
        }
      }
    }
  }
  return null;
}

// Codex exec --json 不串流輸出、回合結束才給 usage，無法計入即時 tok/s。
export function createCodexParser(onEvent: (ev: CliEvent) => void): (obj: Record<string, unknown>) => void {
  let streamed = '';
  let failed = false;
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
        if (!failed) onEvent({ type: 'result', text: streamed.trim() });
        return;
      case 'turn.failed':
      case 'error': {
        failed = true;
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

export class CodexCliProvider implements CliProvider {
  readonly name = 'codex';
  readonly dangerous: boolean;
  private readonly cfg: CliCommandConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;

  constructor(cfg: CliCommandConfig, envPassthrough: string[]) {
    this.cfg = cfg;
    this.dangerous = cfg.fullAccess;
    this.env = minimalEnv(envPassthrough);
    this.home = this.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
  }

  async available(): Promise<boolean> { return (await findExecutable(this.cfg.command, this.env)) !== null; }

  quota(): Promise<QuotaEvent | null> { return readCodexQuota(this.home); }

  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    let completed = false;
    let failed = false;
    let thread = opts.resumeId;
    const run = runLineProcess(
      {
        command: this.cfg.command, args: codexArgs(this.cfg, opts),
        cwd: opts.cwd, env: this.env, prompt: opts.prompt, label: 'codex',
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
            const quota = await readCodexQuota(this.home, thread);
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
