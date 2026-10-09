// config.yaml 載入與驗證。讀取順序：YUMEEWADE_CONFIG → ./config.yaml → ~/.yumeewade/config.yaml → 內建預設。
// 所有 host／port／路徑／CLI 旗標／上限值都在這裡進來，程式其他地方不得寫死。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYamlMap, type YamlMap, type YamlValue } from './yaml.ts';

export interface CliCommandConfig {
  command: string;
  baseArgs: string[];
  dangerous: boolean;
  dangerousArgs: string[];
}

export interface Config {
  server: { host: string; port: number };
  workspace: { root: string };
  cli: { claude: CliCommandConfig; codex: CliCommandConfig; envPassthrough: string[] };
  limits: {
    bodyBytes: number;
    promptChars: number;
    sendPerMinute: number;
    concurrentRuns: number;
    sseConnections: number;
    queueLength: number;
    handoffChars: number;
    heartbeatSeconds: number;
    diffBytes: number;
  };
  /** 實際採用的設定檔路徑；null＝全部用預設值。 */
  source: string | null;
}

export const DEFAULT_CONFIG: Config = {
  server: { host: '127.0.0.1', port: 4560 },
  workspace: { root: '~/Documents/YuMeewWorkspace' },
  cli: {
    claude: {
      command: 'claude',
      baseArgs: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
      dangerous: false,
      dangerousArgs: ['--dangerously-skip-permissions'],
    },
    codex: {
      command: 'codex',
      baseArgs: ['exec', '--json', '--skip-git-repo-check'],
      dangerous: false,
      dangerousArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    },
    envPassthrough: [],
  },
  limits: {
    bodyBytes: 1_048_576,
    promptChars: 10_000,
    sendPerMinute: 30,
    concurrentRuns: 2,
    sseConnections: 20,
    queueLength: 20,
    handoffChars: 24_000,
    heartbeatSeconds: 15,
    diffBytes: 2_000_000,
  },
  source: null,
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function section(map: YamlMap, key: string): YamlMap {
  const v = map[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ConfigError(`${key} 必須是物件`);
  return v;
}

function str(map: YamlMap, key: string, fallback: string, where: string): string {
  const v = map[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string' || v === '') throw new ConfigError(`${where}.${key} 必須是非空字串`);
  return v;
}

function int(map: YamlMap, key: string, fallback: number, where: string): number {
  const v = map[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new ConfigError(`${where}.${key} 必須是正整數`);
  return v;
}

function bool(map: YamlMap, key: string, fallback: boolean, where: string): boolean {
  const v = map[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new ConfigError(`${where}.${key} 必須是 true／false`);
  return v;
}

function strList(map: YamlMap, key: string, fallback: string[], where: string): string[] {
  const v: YamlValue | undefined = map[key];
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ConfigError(`${where}.${key} 必須是字串清單`);
  return v as string[];
}

function cliSection(map: YamlMap, name: 'claude' | 'codex'): CliCommandConfig {
  const s = section(map, name);
  const d = DEFAULT_CONFIG.cli[name];
  const where = `cli.${name}`;
  return {
    command: str(s, 'command', d.command, where),
    baseArgs: strList(s, 'baseArgs', d.baseArgs, where),
    dangerous: bool(s, 'dangerous', d.dangerous, where),
    dangerousArgs: strList(s, 'dangerousArgs', d.dangerousArgs, where),
  };
}

/** 把 YAML 內容套在預設值上並驗證。 */
export function parseConfig(text: string, source: string | null): Config {
  const map = parseYamlMap(text);
  const server = section(map, 'server');
  const workspace = section(map, 'workspace');
  const cli = section(map, 'cli');
  const limits = section(map, 'limits');
  const d = DEFAULT_CONFIG;
  const host = str(server, 'host', d.server.host, 'server');
  if (!isLoopbackHost(host)) throw new ConfigError(`server.host 只允許 127.0.0.1／localhost／::1，拒絕 ${host}`);
  const port = int(server, 'port', d.server.port, 'server');
  if (port > 65535) throw new ConfigError('server.port 超出範圍');
  const L = d.limits;
  return {
    server: { host, port },
    workspace: { root: expandHome(str(workspace, 'root', d.workspace.root, 'workspace')) },
    cli: {
      claude: cliSection(cli, 'claude'),
      codex: cliSection(cli, 'codex'),
      envPassthrough: strList(cli, 'envPassthrough', d.cli.envPassthrough, 'cli'),
    },
    limits: {
      bodyBytes: int(limits, 'bodyBytes', L.bodyBytes, 'limits'),
      promptChars: int(limits, 'promptChars', L.promptChars, 'limits'),
      sendPerMinute: int(limits, 'sendPerMinute', L.sendPerMinute, 'limits'),
      concurrentRuns: int(limits, 'concurrentRuns', L.concurrentRuns, 'limits'),
      sseConnections: int(limits, 'sseConnections', L.sseConnections, 'limits'),
      queueLength: int(limits, 'queueLength', L.queueLength, 'limits'),
      handoffChars: int(limits, 'handoffChars', L.handoffChars, 'limits'),
      heartbeatSeconds: int(limits, 'heartbeatSeconds', L.heartbeatSeconds, 'limits'),
      diffBytes: int(limits, 'diffBytes', L.diffBytes, 'limits'),
    },
    source,
  };
}

export function configCandidates(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const out: string[] = [];
  const fromEnv = env['YUMEEWADE_CONFIG'];
  if (fromEnv) out.push(path.resolve(expandHome(fromEnv)));
  out.push(path.join(cwd, 'config.yaml'), path.join(os.homedir(), '.yumeewade', 'config.yaml'));
  return out;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<Config> {
  for (const candidate of configCandidates(env, cwd)) {
    let text: string;
    try {
      text = await fs.readFile(candidate, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    return parseConfig(text, candidate);
  }
  return { ...DEFAULT_CONFIG, workspace: { root: expandHome(DEFAULT_CONFIG.workspace.root) } };
}
