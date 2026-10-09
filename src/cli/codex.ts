// codex CLI adapter（實測 0.160.1，PLAN.md A.5）。
// 指令：{command} {baseArgs} [-m m] [-c model_reasoning_effort=e] [--add-dir d]… [dangerousArgs] [resume sid -]，提示由 stdin 送入。
// 解析：thread.started.thread_id、item.completed（agent_message 文字、command_execution 摘要）、turn.completed／turn.failed／error。

import type { CliCommandConfig } from '../shared/config.ts';
import { findExecutable, minimalEnv, runLineProcess } from './process.ts';
import type { CliEvent, CliProvider, CliRun, SendOptions } from './provider.ts';

export class CodexCliProvider implements CliProvider {
  readonly name = 'codex';
  readonly dangerous: boolean;
  private readonly cfg: CliCommandConfig;
  private readonly env: NodeJS.ProcessEnv;

  constructor(cfg: CliCommandConfig, envPassthrough: string[]) {
    this.cfg = cfg;
    this.dangerous = cfg.dangerous;
    this.env = minimalEnv(envPassthrough);
  }

  available(): Promise<boolean> {
    return findExecutable(this.cfg.command, this.env);
  }

  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    const args = [...this.cfg.baseArgs];
    if (opts.model) args.push('-m', opts.model);
    if (opts.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`);
    for (const d of opts.addDirs ?? []) args.push('--add-dir', d);
    if (this.cfg.dangerous) args.push(...this.cfg.dangerousArgs);
    if (opts.resumeId) args.push('resume', opts.resumeId, '-');

    let streamed = '';
    let failed = false;
    const proc = runLineProcess({ command: this.cfg.command, args, cwd: opts.cwd, env: this.env, prompt: opts.prompt, label: 'codex' }, (obj) => {
      switch (obj['type']) {
        case 'thread.started': {
          if (typeof obj['thread_id'] === 'string') onEvent({ type: 'session', id: obj['thread_id'] });
          return;
        }
        case 'item.completed': {
          const item = obj['item'];
          if (!item || typeof item !== 'object') return;
          const it = item as Record<string, unknown>;
          if (it['type'] === 'agent_message' && typeof it['text'] === 'string') {
            const text = (streamed ? '\n\n' : '') + it['text'];
            streamed += text;
            onEvent({ type: 'delta', text });
          } else if (it['type'] === 'command_execution' && typeof it['command'] === 'string') {
            const note = `\n⚙ ${it['command'].slice(0, 120)}\n`;
            streamed += note;
            onEvent({ type: 'delta', text: note });
          } else if (it['type'] === 'error') {
            failed = true;
            onEvent({ type: 'error', reason: `item error: ${String(it['message'] ?? '').slice(0, 200)}` });
          }
          return;
        }
        case 'turn.completed': {
          if (!failed) onEvent({ type: 'result', text: streamed.trim() });
          return;
        }
        case 'turn.failed':
        case 'error': {
          failed = true;
          const err = obj['error'];
          const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(obj['message'] ?? obj['type']);
          onEvent({ type: 'error', reason: msg.slice(0, 200) });
          return;
        }
        default:
          return;
      }
    });
    return { stop: proc.stop, done: proc.done };
  }
}
