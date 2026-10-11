// Google Gemini via the Antigravity CLI (`agy`) print mode.
// The prompt travels over stdin as one stream-json "user" message, never argv; the CLI's own login is used.
import { randomUUID } from 'node:crypto';
import type { CliCommandConfig } from '../shared/config.ts';
import type { TurnUsage } from '../shared/types.ts';
import { findExecutable, minimalEnv, runLineProcess } from './process.ts';
import type { CliEvent, CliProvider, CliRun, RunOutcome, SendOptions } from './provider.ts';

export function geminiArgs(cfg: CliCommandConfig, opts: SendOptions): string[] {
  const args = [...((opts.fullAccess ?? cfg.fullAccess) ? cfg.fullAccessArgs : cfg.safeArgs), ...cfg.baseArgs];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.resumeId) args.push('--conversation', opts.resumeId);
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
  return args;
}

/** Print-mode stream input accepts text blocks only, so image files are handed over as paths the agent can open. */
export function geminiInput(opts: SendOptions): string {
  const images = opts.images ?? [];
  const text = images.length ? `${opts.prompt}\n\nAttached image files (open them with your tools):\n${images.join('\n')}` : opts.prompt;
  return `${JSON.stringify({ event: 'user', message: { content: text } })}\n`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0; }

function toolLabel(info: Record<string, unknown> | undefined, fallback: unknown): string {
  const name = typeof info?.['name'] === 'string' ? info['name'] : typeof fallback === 'string' ? fallback : 'tool';
  const detail = Object.values(record(info?.['parameters']) ?? {}).find((value): value is string => typeof value === 'string' && value.length > 0);
  return (detail ? `${name}: ${detail}` : name).slice(0, 160);
}

export function createGeminiParser(onEvent: (ev: CliEvent) => void, now: () => number = Date.now): (obj: Record<string, unknown>) => void {
  const runId = randomUUID();
  const started = now();
  let terminal = false;
  let text = '';
  let input = 0;
  let output = 0;
  let cached = 0;
  const tools = new Set<number>();
  return obj => {
    if (terminal) return;
    if (obj['event'] === 'step_update') {
      const step = record(obj['step_update']);
      if (!step) return;
      if (step['step_type'] === 'agent_response') {
        const delta = step['text_delta'];
        if (typeof delta === 'string' && delta) { text += delta; onEvent({ type: 'delta', text: delta }); }
        const usage = record(step['usage']);
        if (step['state'] === 'DONE' && usage) {
          input += count(usage['input_tokens']);
          output += count(usage['output_tokens']);
          cached += count(usage['cache_read_tokens']);
          const at = now();
          const spanMs = at - started;
          if (output > 0 && spanMs > 0) onEvent({ type: 'tokens', runId, count: output, spanMs, at });
        }
      } else if (step['step_type'] === 'tool' && step['state'] === 'ACTIVE') {
        const index = step['step_index'];
        if (typeof index !== 'number' || tools.has(index)) return;
        tools.add(index);
        onEvent({ type: 'tool', text: toolLabel(record(step['tool_info']), step['tool_name']) });
      }
      return;
    }
    if (obj['event'] !== 'result') return;
    terminal = true;
    const result = record(obj['result']);
    const id = result?.['conversation_id'];
    if (!result || result['status'] !== 'SUCCESS' || typeof id !== 'string' || !id) {
      const reason = typeof result?.['error'] === 'string' && result['error'] ? result['error'].slice(0, 200) : `Gemini turn ended with ${String(result?.['status'])}`;
      onEvent({ type: 'error', reason });
      return;
    }
    onEvent({ type: 'session', id });
    if (input + output > 0) onEvent({ type: 'usage', usage: { input, output, ...(cached ? { cached } : {}) } satisfies TurnUsage });
    onEvent({ type: 'result', text: typeof result['response'] === 'string' ? result['response'] : text });
  };
}

/** Process exit and a terminal success result are both required. */
export function geminiOutcome(outcome: RunOutcome, completed: boolean, failed: boolean): RunOutcome {
  if (!outcome.ok || outcome.stopped) return outcome;
  if (failed) return { ...outcome, ok: false, reason: 'Gemini turn failed' };
  if (!completed) return { ...outcome, ok: false, reason: 'no Gemini result event' };
  return outcome;
}

export class GeminiCliProvider implements CliProvider {
  readonly name = 'gemini';
  readonly dangerous: boolean;
  private readonly cfg: CliCommandConfig;
  private readonly env: NodeJS.ProcessEnv;
  constructor(cfg: CliCommandConfig, envPassthrough: string[], env?: NodeJS.ProcessEnv) {
    this.cfg = cfg;
    this.dangerous = cfg.fullAccess;
    this.env = env ?? minimalEnv(envPassthrough);
  }
  async available(): Promise<boolean> { return (await findExecutable(this.cfg.command, this.env)) !== null; }
  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    if (opts.slashCommand) {
      const reason = 'Gemini print mode slash commands are unsupported';
      onEvent({ type: 'error', reason });
      return { stop: () => undefined, done: Promise.resolve({ ok: false, stopped: false, reason }) };
    }
    let completed = false;
    let failed = false;
    const run = runLineProcess({ command: this.cfg.command, args: geminiArgs(this.cfg, opts), cwd: opts.cwd, env: this.env, prompt: geminiInput(opts), label: 'gemini' }, createGeminiParser(ev => {
      if (ev.type === 'result') completed = true;
      if (ev.type === 'error') failed = true;
      onEvent(ev);
    }));
    const done = run.done.then(outcome => {
      const final = geminiOutcome(outcome, completed, failed);
      if (!final.ok && !final.stopped && !failed) onEvent({ type: 'error', reason: final.reason ?? 'Gemini process failed' });
      return final;
    });
    return { done, stop: () => run.stop() };
  }
}
