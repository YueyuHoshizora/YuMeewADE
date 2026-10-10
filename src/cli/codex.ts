// Codex --json adapter（含舊版 msg 事件）；工具不混入回答。
import type { CliCommandConfig } from '../shared/config.ts';
import { findExecutable, minimalEnv, runLineProcess } from './process.ts';
import type { CliEvent, CliProvider, CliRun, SendOptions } from './provider.ts';

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

  constructor(cfg: CliCommandConfig, envPassthrough: string[]) {
    this.cfg = cfg;
    this.dangerous = cfg.fullAccess;
    this.env = minimalEnv(envPassthrough);
  }

  async available(): Promise<boolean> { return (await findExecutable(this.cfg.command, this.env)) !== null; }

  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    let completed = false;
    let failed = false;
    const run = runLineProcess(
      {
        command: this.cfg.command, args: codexArgs(this.cfg, opts),
        cwd: opts.cwd, env: this.env, prompt: opts.prompt, label: 'codex',
      },
      createCodexParser(ev => {
        if (ev.type === 'result') completed = true;
        if (ev.type === 'error') failed = true;
        onEvent(ev);
      }),
    );
    return {
      stop: run.stop,
      done: run.done.then(outcome => {
        if (!outcome.ok || outcome.stopped) return outcome;
        if (failed) return { ...outcome, ok: false, reason: 'turn failed' };
        if (completed) return outcome;
        onEvent({ type: 'error', reason: 'no result event' });
        return { ...outcome, ok: false, reason: 'no result event' };
      }),
    };
  }
}
