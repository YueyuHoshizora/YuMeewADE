import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import type { SlashCommand } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { findExecutable, spawnCli, terminateTree } from './process.ts';

export function slashName(text: string): string | null {
  return /^\/([^\s]+)(?:\s|$)/u.exec(text.trimStart())?.[1] ?? null;
}

/** SDK initialize only: no user message, inference, credential output, or command execution. */
export async function claudeCommands(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<SlashCommand[]> {
  const executable = await findExecutable(command, env);
  if (!executable) throw new AppError('bad_request', 'cli_unavailable');
  const child = spawnCli(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
  const { promise, resolve, reject } = Promise.withResolvers<SlashCommand[]>();
  const closed = Promise.withResolvers<void>();
  const terminated = Promise.withResolvers<void>();
  let settled = false;
  let buffer = '';
  let bytes = 0;
  let cancelStop: (() => void) | undefined;
  const finish = (commands?: SlashCommand[]) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cancelStop = terminateTree(child, () => terminated.resolve());
    if (commands) resolve(commands); else reject(new AppError('unavailable'));
  };
  const timer = setTimeout(() => finish(), timeoutMs);
  child.on('error', () => finish());
  child.on('close', () => { closed.resolve(); finish(); cancelStop?.(); });
  child.stdin?.on('error', () => finish());
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2 * 1024 * 1024) { finish(); return; }
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      if (message['type'] !== 'control_response') continue;
      const response = message['response'] as { request_id?: string; subtype?: string; response?: { commands?: unknown } } | undefined;
      if (response?.request_id !== 'commands') continue;
      if (response.subtype !== 'success' || !Array.isArray(response.response?.commands)) { finish(); return; }
      finish(normalizeCommands(response.response.commands));
    }
  });
  child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: 'commands', request: { subtype: 'initialize' } })}\n`);
  try { return await promise; }
  finally {
    await Promise.race([closed.promise, terminated.promise]);
    cancelStop?.();
  }
}

/** The only CLI commands not offered: account sign-in belongs to the App's account flow, and the model to its picker. */
export const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set(['login', 'logout', 'model']);

export function normalizeCommands(values: unknown[]): SlashCommand[] {
  const commands = new Map<string, SlashCommand>();
  for (const value of values.slice(0, 1000)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (typeof row['name'] === 'string' && EXCLUDED_COMMANDS.has(row['name'])) continue;
    if (typeof row['name'] !== 'string' || typeof row['description'] !== 'string') continue;
    const names = [row['name'], ...(Array.isArray(row['aliases']) ? row['aliases'] : [])];
    for (const name of names) {
      if (typeof name !== 'string' || !/^[\p{L}\p{N}_:./-]{1,150}$/u.test(name) || name.startsWith('__') || EXCLUDED_COMMANDS.has(name)) continue;
      commands.set(name, { name, description: row['description'].slice(0, 2000), ...(typeof row['argumentHint'] === 'string' && row['argumentHint'] ? { argumentHint: row['argumentHint'].slice(0, 500) } : {}) });
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

interface PromptFile extends SlashCommand { body: string }
const PROMPT_BYTES = 100_000;

/** Codex's documented custom prompts are top-level Markdown files in CODEX_HOME/prompts, not project .codex/prompts. */
export async function codexPrompts(home: string): Promise<PromptFile[]> {
  const root = path.join(home, 'prompts');
  let entries;
  try {
    if (!(await fs.lstat(root)).isDirectory()) return [];
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const prompts: PromptFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1000)) {
    if (!entry.isFile() || !/^[\p{L}\p{N}_-]{1,120}\.md$/u.test(entry.name)) continue;
    const handle = await fs.open(path.join(root, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > PROMPT_BYTES) continue;
      const buffer = Buffer.alloc(PROMPT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > PROMPT_BYTES) continue;
      const text = buffer.toString('utf8', 0, bytesRead);
      const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
      const metadata = (key: string) => {
        const raw = new RegExp(`^${key}:\\s*(.*)$`, 'mu').exec(front?.[1] ?? '')?.[1]?.trim() ?? '';
        return raw.replace(/^(["'])(.*)\1$/u, '$2');
      };
      prompts.push({ name: `prompts:${entry.name.slice(0, -3)}`, description: metadata('description').slice(0, 2000), ...(metadata('argument-hint') ? { argumentHint: metadata('argument-hint').slice(0, 500) } : {}), body: front ? text.slice(front[0].length) : text });
    } finally { await handle.close(); }
  }
  return prompts;
}

/** Shell-style quoting only; no interpolation, shell, environment lookup, or file expansion. */
export function promptArguments(tail: string): string[] {
  const args: string[] = [];
  let value = ''; let quote = ''; let started = false;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i]!;
    if (c === '\\' && quote !== "'") {
      if (++i >= tail.length) throw new AppError('bad_request');
      // POSIX: inside double quotes a backslash only escapes $ ` " \ and newline; `"C:\Users\a"` keeps its backslashes.
      if (quote === '"' && !'$`"\\\n'.includes(tail[i]!)) value += '\\';
      value += tail[i]; started = true;
    } else if (quote) {
      if (c === quote) quote = ''; else value += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/u.test(c)) { if (started) { args.push(value); value = ''; started = false; } }
    else { value += c; started = true; }
  }
  if (quote) throw new AppError('bad_request');
  if (started) args.push(value);
  return args;
}

export function expandCodexPrompt(body: string, tail: string): string {
  const args = promptArguments(tail);
  const named = new Map<string, string>();
  for (const arg of args) {
    const match = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/u.exec(arg);
    if (match) named.set(match[1]!, match[2]!);
  }
  const expanded = body.replace(/\$\$|\$ARGUMENTS\b|\$([1-9])|\$([A-Z][A-Z0-9_]*)/gu, (match: string, position?: string, name?: string) => {
    if (match === '$$') return '$';
    if (match === '$ARGUMENTS') return args.join(' ');
    if (position) return args[Number(position) - 1] ?? '';
    if (!name || !named.has(name)) throw new AppError('bad_request');
    return named.get(name)!;
  });
  if (!expanded.trim() || expanded.length > PROMPT_BYTES) throw new AppError('bad_request');
  return expanded;
}
