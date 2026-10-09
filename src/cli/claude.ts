// claude CLI adapter（實測 2.1.294，PLAN.md A.5）。
// 指令：{command} {baseArgs} [--model m] [--effort e] [--resume sid] [--add-dir d]… [dangerousArgs]，提示由 stdin 送入。
// 解析：system/init.session_id、stream_event 的 text_delta（增量）與 tool_use 開頭、assistant 文字（無串流時備援）、result。

import type { CliCommandConfig } from '../shared/config.ts';
import { findExecutable, minimalEnv, runLineProcess } from './process.ts';
import type { CliEvent, CliProvider, CliRun, SendOptions } from './provider.ts';

export function claudeArgs(cfg: CliCommandConfig, opts: SendOptions): string[] {
  const args = [...cfg.baseArgs];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.resumeId) args.push('--resume', opts.resumeId);
  for (const d of opts.addDirs ?? []) args.push('--add-dir', d);
  if (cfg.dangerous) args.push(...cfg.dangerousArgs);
  return args;
}

/** 逐行解析 stream-json；回傳的函式每收到一個 JSON 物件呼叫一次。 */
export function createClaudeParser(onEvent: (ev: CliEvent) => void): (obj: Record<string, unknown>) => void {
  let streamed = '';
  let sawStream = false;
  let sessionSent = false;
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
        if (e['type'] === 'content_block_delta') {
          const delta = e['delta'];
          if (delta && typeof delta === 'object' && 'type' in delta && delta.type === 'text_delta' && 'text' in delta && typeof delta.text === 'string') {
            sawStream = true;
            streamed += delta.text;
            onEvent({ type: 'delta', text: delta.text });
          }
        } else if (e['type'] === 'content_block_start') {
          const block = e['content_block'];
          if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_use' && 'name' in block && typeof block.name === 'string') {
            const note = `\n⚙ ${block.name}\n`;
            streamed += note;
            onEvent({ type: 'delta', text: note });
          }
        }
        return;
      }
      case 'assistant': {
        if (sawStream) return; // 已逐字串流，整段訊息不再重複
        const msg = obj['message'];
        if (!msg || typeof msg !== 'object' || !('content' in msg) || !Array.isArray(msg.content)) return;
        for (const block of msg.content as unknown[]) {
          if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
            streamed += block.text;
            onEvent({ type: 'delta', text: block.text });
          }
        }
        return;
      }
      case 'result': {
        const isError = obj['is_error'] === true || (typeof obj['subtype'] === 'string' && obj['subtype'] !== 'success');
        const text = typeof obj['result'] === 'string' ? obj['result'] : '';
        if (isError) onEvent({ type: 'error', reason: `result ${String(obj['subtype'])}: ${text.slice(0, 200)}` });
        else onEvent({ type: 'result', text: streamed.trim() || text });
        return;
      }
      default:
        return;
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
    this.dangerous = cfg.dangerous;
    this.env = minimalEnv(envPassthrough);
  }

  available(): Promise<boolean> {
    return findExecutable(this.cfg.command, this.env);
  }

  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    const proc = runLineProcess(
      { command: this.cfg.command, args: claudeArgs(this.cfg, opts), cwd: opts.cwd, env: this.env, prompt: opts.prompt, label: 'claude' },
      createClaudeParser(onEvent),
    );
    return { stop: proc.stop, done: proc.done };
  }
}
