import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CliCommandConfig } from '../shared/config.ts';
import type { McpAi, McpInput, McpList, McpServer, McpTransport } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { randomUUID } from 'node:crypto';
import { captureCommand } from './process.ts';
import { readCredentialFile } from './credential-file.ts';

const invalid = () => new AppError('bad_request');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, max = 8192, empty = false): string {
  if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max || /[\0\r\n]/u.test(v)) throw invalid();
  return v;
}
export function mcpAi(v: unknown): McpAi {
  if (v !== 'claude' && v !== 'codex' && v !== 'grok' && v !== 'gemini') throw invalid();
  return v;
}
export function mcpName(v: unknown): string {
  const name = text(v, 80);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(name)) throw invalid();
  return name;
}
function pairs(v: unknown, header: boolean): Record<string, string> {
  if (v === undefined) return {};
  if (!object(v) || Object.keys(v).length > 64) throw invalid();
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(v)) {
    if (key.length > 128 || !(header ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u : /^[A-Za-z_][A-Za-z0-9_]*$/u).test(key)) throw invalid();
    out[key] = text(value, 8192, true);
  }
  return out;
}
export function validateMcpInput(v: unknown): McpInput {
  if (!object(v) || Object.keys(v).some(k => !['name', 'transport', 'command', 'args', 'env', 'url', 'headers'].includes(k)) || JSON.stringify(v).length > 131072) throw invalid();
  const name = mcpName(v['name']); const transport = v['transport'];
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') throw invalid();
  if (transport === 'stdio') {
    if (v['url'] !== undefined || v['headers'] !== undefined) throw invalid();
    const command = text(v['command'], 4096);
    if (command.startsWith('-')) throw invalid();
    const args = v['args'] ?? [];
    if (!Array.isArray(args) || args.length > 128) throw invalid();
    return { name, transport, command, args: args.map(a => text(a, 8192, true)), env: pairs(v['env'], false) };
  }
  if (v['command'] !== undefined || v['args'] !== undefined || v['env'] !== undefined) throw invalid();
  const url = text(v['url'], 4096);
  try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw invalid(); } catch { throw invalid(); }
  return { name, transport, url, headers: pairs(v['headers'], true) };
}
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try { const u = new URL(v); if (!['http:', 'https:'].includes(u.protocol)) return undefined; return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 4096); } catch { return undefined; }
}
function status(v: unknown): McpServer['status'] {
  if (typeof v !== 'string') return 'unknown';
  if (/disabled/iu.test(v)) return 'disabled';
  if (/pending|approval/iu.test(v)) return 'pending';
  if (/failed|error|disconnected/iu.test(v)) return 'failed';
  if (/connected|healthy/iu.test(v)) return 'connected';
  if (/enabled/iu.test(v)) return 'enabled';
  return 'unknown';
}
/** Explicit allowlist: never serialize CLI env/header/argument values or raw error text. */
export function parseMcpList(output: string): McpServer[] {
  if (Buffer.byteLength(output) > 1048576) throw new AppError('unavailable');
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { parsed = undefined; }
  if (parsed !== undefined) {
    const container = object(parsed) && object(parsed['mcpServers']) ? parsed['mcpServers'] : parsed;
    const rows = Array.isArray(container) ? container : object(container) && Array.isArray(container['servers']) ? container['servers'] : object(container) ? Object.entries(container).map(([name, row]) => object(row) ? { ...row, name } : {}) : [];
    if (rows.length > 256) throw new AppError('unavailable');
    return rows.map((value): McpServer => {
      if (!object(value)) throw new AppError('unavailable');
      const source = object(value['transport']) ? value['transport'] : value;
      const kind = source['type'] ?? source['transport'];
      const address = source['url'] ?? source['serverUrl'] ?? source['httpUrl'];
      const transport: McpTransport = kind === 'sse' ? 'sse' : kind === 'http' || kind === 'streamable_http' || address ? 'http' : 'stdio';
      const command = typeof source['command'] === 'string' ? source['command'].split(/\s/u)[0]?.slice(0, 4096) : undefined;
      const environment = source['env'] ?? value['env'];
      const headers = source['headers'] ?? source['http_headers'] ?? value['headers'] ?? value['http_headers'];
      const envKeys = object(environment) ? Object.keys(environment).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)).slice(0, 64) : [];
      const headerKeys = object(headers) ? Object.keys(headers).filter(key => /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(key)).slice(0, 64) : [];
      return { name: mcpName(value['name']), transport, envKeys, headerKeys, ...(transport === 'stdio' && command ? { command } : {}), ...(safeUrl(address) ? { url: safeUrl(address)! } : {}), scope: ['user', 'project', 'local'].includes(String(value['scope'])) ? String(value['scope']) : 'user', status: value['enabled'] === false || value['disabled'] === true ? 'disabled' : status(value['status'] ?? value['state']) };
    });
  }
  const rows: McpServer[] = [];
  for (const line of output.replace(/\x1b\[[0-9;]*m/gu, '').split('\n')) {
    const match = /^\s*(?:[✓✗⏸•]\s*)?([A-Za-z0-9_][A-Za-z0-9_-]{0,79}):\s*(.+)$/u.exec(line);
    if (!match || ['Checking', 'Scope', 'Status', 'Transport', 'Command', 'URL', 'Environment', 'Headers'].includes(match[1]!)) continue;
    const rest = match[2]!; const url = /https?:\/\/[^\s]+/u.exec(rest)?.[0];
    const transport: McpTransport = /\(sse\)|\bsse\b/iu.test(rest) ? 'sse' : url ? 'http' : 'stdio';
    const address = safeUrl(url);
    rows.push({ name: match[1]!, transport, envKeys: [], headerKeys: [], ...(address ? { url: address } : !url ? { command: rest.split(/\s/u)[0]!.slice(0, 4096) } : {}), scope: 'user', status: status(rest) });
    if (rows.length > 256) throw new AppError('unavailable');
  }
  if (!rows.length && output.trim() && !/no .*servers|no servers|checking mcp server health/iu.test(output)) throw new AppError('unavailable');
  return rows;
}
export function mcpHome(ai: McpAi, env: NodeJS.ProcessEnv): string {
  const home = env[ai === 'claude' ? 'CLAUDE_CONFIG_DIR' : ai === 'codex' ? 'CODEX_HOME' : ai === 'grok' ? 'GROK_HOME' : 'HOME'];
  if (!home) throw new AppError('unavailable');
  return home;
}
async function invoke(config: CliCommandConfig, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const result = await captureCommand({ command: config.command, args, env, cwd, timeoutMs: 30000, maxOutputBytes: 1048576, maxStderrBytes: 1048576 });
  if (!result.ok) throw new AppError('unavailable');
  return result.stdout || result.stderr;
}
export async function mcpCapabilities(ai: McpAi, config: CliCommandConfig, env: NodeJS.ProcessEnv): Promise<McpList> {
  const home = mcpHome(ai, env);
  if (!config.mcpListArgs?.length || !config.mcpAddArgs?.length || !config.mcpRemoveArgs?.length) return { supported: false, transports: [], servers: [] };
  const help = await captureCommand({ command: config.command, args: ['--help'], env, cwd: home, timeoutMs: 15000, maxOutputBytes: 65536, maxStderrBytes: 65536 });
  if (!help.ok || !/\bmcp\b/u.test(help.stdout + help.stderr)) return { supported: false, transports: [], servers: [] };
  return { supported: true, transports: ai === 'codex' || ai === 'gemini' ? ['stdio', 'http'] : ['stdio', 'http', 'sse'], servers: [] };
}
export async function listMcp(ai: McpAi, config: CliCommandConfig, env: NodeJS.ProcessEnv): Promise<McpList> {
  const result = await mcpCapabilities(ai, config, env);
  if (result.supported) {
    const home = mcpHome(ai, env);
    const output = await invoke(config, config.mcpListArgs!, env, home);
    if (ai === 'claude' || ai === 'gemini') {
      // These CLIs have human-only list output. Native account config supplies metadata, not a guessed text layout.
      const file = ai === 'claude' ? path.join(home, '.claude.json') : path.join(home, '.gemini', 'config', 'mcp_config.json');
      let document: unknown;
      try { document = JSON.parse(await readCredentialFile(file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('unavailable'); }
      const servers = object(document) && object(document['mcpServers']) ? document['mcpServers'] : {};
      result.servers = parseMcpList(JSON.stringify(servers));
      for (const server of result.servers) {
        const line = output.split('\n').find(line => new RegExp(`(?:^|\\s)${server.name}(?::|\\s)`, 'u').test(line));
        if (line && status(line) !== 'unknown') server.status = status(line);
      }
    } else result.servers = parseMcpList(output);
  }
  return result;
}
export async function addMcp(ai: McpAi, config: CliCommandConfig, env: NodeJS.ProcessEnv, raw: unknown): Promise<void> {
  const input = validateMcpInput(raw); const capabilities = await mcpCapabilities(ai, config, env);
  if (!capabilities.supported || !capabilities.transports.includes(input.transport)) throw invalid();
  const home = mcpHome(ai, env);
  const existing = await listMcp(ai, config, env);
  if (existing.servers.length >= 256 || existing.servers.some(s => s.name === input.name)) throw new AppError('conflict');
  const args = [...config.mcpAddArgs!];
  if (ai !== 'codex') args.push(ai === 'gemini' ? '--type' : '--transport', input.transport);
  const envFlags = Object.entries(input.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const headerFlags = ai === 'codex' ? [] : Object.entries(input.headers ?? {}).flatMap(([key, value]) => ['--header', `${key}: ${value}`]);
  if (ai === 'claude') {
    // Claude's -e/--env and -H/--header are variadic: placed before <name> they swallow it. Its own usage puts env after
    // the name (before `--`) and headers after the URL.
    args.push(input.name);
    if (input.transport === 'stdio') args.push(...envFlags, '--', input.command!, ...input.args!);
    else args.push(input.url!, ...headerFlags);
  } else {
    args.push(...envFlags, ...headerFlags, input.name);
    if (input.transport === 'stdio') args.push('--', input.command!, ...input.args!);
    else if (ai === 'codex') args.push('--url', input.url!);
    else args.push(input.url!);
  }
  await invoke(config, args, env, home);
  // Codex add exposes no arbitrary-header flag. Persist its native table in the isolated account config.
  if (ai === 'codex' && Object.keys(input.headers ?? {}).length) {
    try {
      const file = path.join(home, 'config.toml'); const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) throw new Error();
      const original = await fs.readFile(file, 'utf8');
      const table = `\n[mcp_servers.${input.name}.http_headers]\n${Object.entries(input.headers!).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join('\n')}\n`;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, original + table, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    } catch { await invoke(config, [...config.mcpRemoveArgs!, input.name], env, home).catch(() => {}); throw new AppError('unavailable'); }
  }
}
export async function removeMcp(ai: McpAi, config: CliCommandConfig, env: NodeJS.ProcessEnv, name: unknown): Promise<void> {
  const valid = mcpName(name); const caps = await mcpCapabilities(ai, config, env);
  if (!caps.supported) throw invalid();
  await invoke(config, [...config.mcpRemoveArgs!, valid], env, mcpHome(ai, env));
}
