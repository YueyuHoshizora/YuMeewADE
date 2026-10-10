// Grok native streaming-json adapter; wire schema: xai-grok-pager/headless/reducer/acp.rs.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliCommandConfig } from '../shared/config.ts';
import type { TurnUsage } from '../shared/types.ts';
import { log } from '../shared/log.ts';
import { findExecutable, minimalEnv, runLineProcess } from './process.ts';
import type { CliEvent, CliProvider, CliRun, RunOutcome, SendOptions } from './provider.ts';
import { fetchGrokQuota } from './grok-quota.ts';

/** GROK_HOME owns config/sessions; auth and leader overrides must not escape an extra profile. */
export function grokEnv(env: NodeJS.ProcessEnv, configDir?: string): NodeJS.ProcessEnv {
  if (!configDir) return env;
  const out = { ...env };
  // xai-grok-env/src/registry.rs: first-party credential overrides.
  for (const key of ['GROK_AUTH', 'GROK_AUTH_PATH', 'XAI_API_KEY', 'GROK_DEPLOYMENT_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_EXTRA_AUTH_KEY', 'GROK_TRACE_UPLOAD_CREDENTIALS_FILE', 'OTEL_EXPORTER_OTLP_HEADERS', 'GROK_INTERNAL_OTLP_HEADERS']) delete out[key];
  out['GROK_HOME'] = configDir;
  out['GROK_AUTH_PATH'] = path.join(configDir, 'auth.json');
  out['GROK_LEADER_SOCKET'] = path.join(configDir, 'leader.sock');
  return out;
}

export function grokArgs(cfg: CliCommandConfig, opts: SendOptions, promptFile: string, sessionId: string): string[] {
  const args = [...((opts.fullAccess ?? cfg.fullAccess) ? cfg.fullAccessArgs : cfg.safeArgs), ...cfg.baseArgs, '--prompt-file', promptFile];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--reasoning-effort', opts.effort);
  if (opts.resumeId) args.push('--resume', opts.resumeId);
  else args.push('--session-id', sessionId);
  return args;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function usage(value: unknown): TurnUsage | undefined {
  const u = record(value);
  if (!u || !count(u['input_tokens']) || !count(u['output_tokens'])) return;
  const cached = u['cache_read_input_tokens'];
  const creation = u['cache_creation_input_tokens'];
  if ((cached !== undefined && !count(cached)) || (creation !== undefined && !count(creation))) return;
  const input = u['input_tokens'] + (count(creation) ? creation : 0);
  if (!Number.isSafeInteger(input)) return;
  return { input, output: u['output_tokens'], ...(count(cached) ? { cached } : {}) };
}

export function createGrokParser(onEvent: (ev: CliEvent) => void, now: () => number = Date.now): (obj: Record<string, unknown>) => void {
  const runId = randomUUID();
  let text = '';
  const started = now();
  let terminal = false;
  const tools = new Set<string>();
  const sample = (u: TurnUsage) => {
    const at = now();
    const spanMs = at - started;
    if (spanMs > 0 && Number.isFinite(spanMs)) onEvent({ type: 'tokens', runId, count: u.output, spanMs, at });
  };
  return obj => {
    if (terminal) return;
    switch (obj['type']) {
      case 'text':
      case 'thought':
      case 'tool_call': {
        if (obj['type'] === 'text' && typeof obj['data'] === 'string') {
          text += obj['data'];
          onEvent({ type: 'delta', text: obj['data'] });
        } else if (obj['type'] === 'tool_call') {
          const id = obj['toolCallId'];
          if (typeof id !== 'string' || tools.has(id)) return;
          tools.add(id);
          const title = obj['title'];
          const name = obj['toolName'];
          onEvent({ type: 'tool', text: (typeof title === 'string' && title ? title : typeof name === 'string' ? name : 'tool').slice(0, 160) });
        }
        return;
      }
      case 'max_turns_reached':
      case 'error':
        terminal = true;
        onEvent({ type: 'error', reason: typeof obj['message'] === 'string' ? obj['message'].slice(0, 200) : 'max turns reached' });
        return;
      case 'end': {
        terminal = true;
        const id = obj['sessionId'];
        if (typeof id !== 'string' || !id || obj['stopReason'] !== 'end_turn' || obj['structuredOutputError'] !== undefined || obj['error'] !== undefined) {
          onEvent({ type: 'error', reason: `incomplete Grok turn: ${String(obj['stopReason'])}` });
          return;
        }
        onEvent({ type: 'session', id });
        if (obj['usage_is_incomplete'] !== true) {
          const u = usage(obj['usage']);
          // Native streaming-json has no response-start timestamp; measure the whole process turn.
          if (u) { onEvent({ type: 'usage', usage: u }); sample(u); }
        }
        onEvent({ type: 'result', text });
      }
    }
  };
}

/** Process exit and terminal protocol success are both required. */
export function grokOutcome(outcome: RunOutcome, completed: boolean, failed: boolean): RunOutcome {
  if (!outcome.ok || outcome.stopped) return outcome;
  if (failed) return { ...outcome, ok: false, reason: 'Grok turn failed' };
  if (!completed) return { ...outcome, ok: false, reason: 'no Grok end event' };
  return outcome;
}

/** ACP blocks preserve image bytes; .json selects the CLI's verified structured prompt loader. */
export async function grokPromptBlocks(opts: SendOptions): Promise<Record<string, unknown>[]> {
  const blocks: Record<string, unknown>[] = [{ type: 'text', text: opts.prompt }];
  for (const filename of opts.images ?? []) {
    const bytes = await fs.readFile(filename);
    const ext = path.extname(filename).toLowerCase();
    const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[ext];
    if (!mimeType) throw new Error('unsupported Grok image type');
    blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType });
  }
  return blocks;
}

export class GrokCliProvider implements CliProvider {
  readonly name = 'grok';
  readonly dangerous: boolean;
  private readonly cfg: CliCommandConfig;
  private readonly env: NodeJS.ProcessEnv;
  constructor(cfg: CliCommandConfig, envPassthrough: string[]) {
    this.cfg = cfg;
    this.dangerous = cfg.fullAccess;
    this.env = minimalEnv(envPassthrough);
  }
  async available(): Promise<boolean> { return (await findExecutable(this.cfg.command, this.env)) !== null; }
  quota(configDir?: string): Promise<Extract<CliEvent, { type: 'quota' }> | null> {
    return fetchGrokQuota(configDir, this.env);
  }
  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    let stopped = false;
    let run: CliRun | undefined;
    const done = (async (): Promise<RunOutcome> => {
      let dir: string | undefined;
      try {
        if (opts.slashCommand) throw new Error('Grok headless slash commands are unsupported');
        let promptFile = '/dev/stdin';
        // Grok has no --add-dir flag. Its own permission policy governs these paths.
        const prompt = opts.prompt + ((opts.addDirs?.length ?? 0) > 0 ? `\n\nAdditional project context directories:\n${opts.addDirs!.join('\n')}` : '');
        if (process.platform === 'win32' || opts.images?.length) {
          dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yumeewade-grok-'));
          await fs.chmod(dir, 0o700);
          promptFile = path.join(dir, 'prompt.json');
          const blocks = await grokPromptBlocks({ ...opts, prompt });
          await fs.writeFile(promptFile, JSON.stringify(blocks), { mode: 0o600, flag: 'wx' });
        }
        if (stopped) return { ok: false, stopped: true };
        let completed = false;
        let failed = false;
        run = runLineProcess({ command: this.cfg.command, args: grokArgs(this.cfg, opts, promptFile, randomUUID()), cwd: opts.cwd, env: grokEnv(this.env, opts.configDir), prompt: dir ? '' : prompt, label: 'grok' }, createGrokParser(ev => {
          if (ev.type === 'result') completed = true;
          if (ev.type === 'error') failed = true;
          onEvent(ev);
        }));
        const outcome = grokOutcome(await run.done, completed, failed);
        if (!outcome.ok && !outcome.stopped && !failed) onEvent({ type: 'error', reason: outcome.reason ?? 'Grok process failed' });
        return outcome;
      } catch (err) {
        if (stopped) return { ok: false, stopped: true };
        const reason = (err as Error).message;
        onEvent({ type: 'error', reason });
        return { ok: false, stopped: false, reason };
      } finally {
        if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(err => log.warn('Grok 暫存提示清理失敗', { message: (err as Error).message }));
      }
    })();
    return { done, stop: () => { stopped = true; run?.stop(); } };
  }
}
