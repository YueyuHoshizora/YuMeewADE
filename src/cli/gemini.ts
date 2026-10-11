// Google Gemini via the Antigravity CLI (`agy`) print mode.
// Prompts use stdin, never argv; read-only slash reports run separately without a model turn.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliCommandConfig } from '../shared/config.ts';
import type { SlashCommand, TurnUsage } from '../shared/types.ts';
import { captureCommand, findExecutable, minimalEnv, runLineProcess } from './process.ts';
import type { CliEvent, CliProvider, CliRun, RunOutcome, SendOptions } from './provider.ts';
import { AppError } from '../shared/errors.ts';
import { normalizeCommands, slashName } from './commands.ts';

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
  const measured = new Map<number, { input: number; output: number; cached: number }>();
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
          const index = step['step_index'];
          const tokens = usage['output_tokens'];
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 ||
              typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) return;
          const previous = measured.get(index);
          const current = { input: count(usage['input_tokens']), output: tokens, cached: count(usage['cache_read_tokens']) };
          input += current.input - (previous?.input ?? 0);
          output += current.output - (previous?.output ?? 0);
          cached += current.cached - (previous?.cached ?? 0);
          measured.set(index, current);
          // step_update carries snapshots: replaying or correcting a step must not add it twice.
          if (previous?.output === current.output) return;
          const at = now();
          const spanMs = at - started;
          if (spanMs > 0) onEvent({ type: 'tokens', runId, count: output, spanMs, at });
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

/** Read-only /usage reports are not conversation results and have no conversation id. */
export function geminiQuota(value: unknown, at = new Date().toISOString()): Extract<CliEvent, { type: 'quota' }> | null {
  const report = record(value);
  const command = record(report?.['command']);
  const groups = record(command?.['data'])?.['groups'];
  if (report?.['status'] !== 'SUCCESS' || command?.['name'] !== 'usage' || !Array.isArray(groups)) return null;
  const windows: Extract<CliEvent, { type: 'quota' }>['windows'] = [];
  for (const value of groups) {
    const group = record(value);
    if (typeof group?.['name'] !== 'string' || !Array.isArray(group['buckets'])) return null;
    for (const value of group['buckets']) {
      const bucket = record(value);
      if (bucket?.['disabled'] === true) continue;
      const remaining = bucket?.['remaining_fraction'];
      const reset = bucket?.['reset_time'];
      const name = bucket?.['name'];
      if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 1
        || typeof name !== 'string' || !name || typeof reset !== 'string' || !Number.isFinite(Date.parse(reset))) return null;
      windows.push({ label: `${group['name']} · ${name}`, usedPercent: (1 - remaining) * 100, resetsAt: reset });
    }
  }
  return windows.length ? { type: 'quota', windows, limited: windows.some(window => window.usedPercent === 100), at } : null;
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
  private environment(configDir?: string): NodeJS.ProcessEnv {
    // agy selects file credentials for SSH sessions instead of the ambient macOS Keychain.
    return configDir ? { ...this.env, HOME: configDir, USERPROFILE: configDir, SSH_TTY: 'yumeewade-cli' } : this.env;
  }
  async commands(cwd: string, configDir?: string): Promise<SlashCommand[]> {
    if (!this.cfg.commandsArgs.length || !this.cfg.slashArgs.length) return [];
    const result = await captureCommand({ command: this.cfg.command, args: this.cfg.commandsArgs, cwd, env: this.environment(configDir), timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 });
    if (!result.ok) throw new AppError('unavailable');
    let report: Record<string, unknown> | undefined;
    try { report = record(JSON.parse(result.stdout)); }
    catch { throw new AppError('unavailable'); }
    const command = record(report?.['command']);
    const commands = record(command?.['data'])?.['commands'];
    if (report?.['status'] !== 'SUCCESS' || command?.['name'] !== 'help' || !Array.isArray(commands)) throw new AppError('unavailable');
    return normalizeCommands(commands);
  }
  async resolveCommand(text: string, cwd: string, configDir?: string): Promise<{ text: string; native: boolean; standalone: boolean }> {
    const name = slashName(text);
    // Discovery lists read-only reports, not arbitrary prompts or persistent TUI controls.
    if (!name || text.trim() !== `/${name}` || !(await this.commands(cwd, configDir)).some(command => command.name === name)) {
      throw new AppError('bad_request', 'slash_unsupported');
    }
    return { text: text.trim(), native: true, standalone: true };
  }
  async quota(configDir?: string): Promise<Extract<CliEvent, { type: 'quota' }> | null> {
    if (!this.cfg.quotaArgs.length) return null;
    const env = this.environment(configDir);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-gemini-quota-'));
    try {
      const result = await captureCommand({ command: this.cfg.command, args: this.cfg.quotaArgs, env, cwd, timeoutMs: 90_000, maxOutputBytes: 1024 * 1024 });
      if (!result.ok) throw new Error('Gemini quota query failed');
      return geminiQuota(JSON.parse(result.stdout));
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }
  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    const name = opts.slashCommand ? slashName(opts.slashCommand) : null;
    if (opts.slashCommand && (!this.cfg.slashArgs.length || !name || opts.slashCommand.trim() !== `/${name}`)) {
      const reason = 'Gemini slash command is unavailable';
      onEvent({ type: 'error', reason });
      return { stop: () => undefined, done: Promise.resolve({ ok: false, stopped: false, reason }) };
    }
    let completed = false;
    let failed = false;
    const emit = (ev: CliEvent) => {
      if (ev.type === 'result') completed = true;
      if (ev.type === 'error') failed = true;
      onEvent(ev);
    };
    const parse = opts.slashCommand ? (obj: Record<string, unknown>) => {
      if (completed || failed) return;
      if (obj['status'] !== 'SUCCESS' || typeof obj['response'] !== 'string' || typeof record(obj['command'])?.['name'] !== 'string') {
        emit({ type: 'error', reason: 'Gemini command report failed' });
        return;
      }
      const quota = geminiQuota(obj);
      if (quota) emit(quota);
      // Read-only reports have no conversation id and must not replace the chat session.
      emit({ type: 'result', text: obj['response'] });
    } : createGeminiParser(emit);
    const run = runLineProcess({
      command: this.cfg.command,
      args: opts.slashCommand ? [...this.cfg.slashArgs, opts.slashCommand.trim()] : geminiArgs(this.cfg, opts),
      cwd: opts.cwd, env: this.environment(opts.configDir),
      prompt: opts.slashCommand ? '' : geminiInput(opts), label: 'gemini',
    }, parse);
    const done = run.done.then(outcome => {
      const final = geminiOutcome(outcome, completed, failed);
      if (!final.ok && !final.stopped && !failed) onEvent({ type: 'error', reason: final.reason ?? 'Gemini process failed' });
      return final;
    });
    return { done, stop: () => run.stop() };
  }
}
