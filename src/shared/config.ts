// config.yaml 載入與驗證。讀取順序：YUMEEWADE_CONFIG → ./config.yaml → ~/.yumeewade/config.yaml → 內建預設。
// 所有 host／port／路徑／CLI 旗標／上限值都在這裡進來，程式其他地方不得寫死。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from './fsx.ts';
import { parseYamlMap, yamlScalar, type YamlMap, type YamlValue } from './yaml.ts';

export interface CliCommandConfig {
  command: string;
  /** 無頭模式必要旗標（adapter 依此解析輸出）。 */
  baseArgs: string[];
  /** 預設是否跳過權限確認；設定頁可逐一覆寫（.yumeewade/settings.json）。 */
  fullAccess: boolean;
  fullAccessArgs: string[];
  /** fullAccess 關閉時改用的權限旗標。 */
  safeArgs: string[];
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
    uploadBytes: number;
    imagesPerSend: number;
    verifySeconds: number;
    verifyOutputBytes: number;
    runSeconds: number;
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
      fullAccess: true,
      fullAccessArgs: ['--dangerously-skip-permissions'],
      // 只自動接受檔案編輯；執行指令會被拒
      safeArgs: ['--permission-mode', 'acceptEdits'],
    },
    codex: {
      command: 'codex',
      baseArgs: ['exec', '--json', '--skip-git-repo-check'],
      fullAccess: true,
      fullAccessArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      // 工作目錄沙箱內可改檔與執行指令，不詢問
      safeArgs: ['-s', 'workspace-write', '-c', 'approval_policy="never"'],
    },
    envPassthrough: [],
  },
  limits: {
    bodyBytes: 2_097_152,
    promptChars: 100_000,
    sendPerMinute: 30,
    concurrentRuns: 3,
    sseConnections: 30,
    queueLength: 20,
    handoffChars: 60_000,
    heartbeatSeconds: 15,
    diffBytes: 2_000_000,
    uploadBytes: 20_971_520,
    imagesPerSend: 10,
    verifySeconds: 600,
    verifyOutputBytes: 65_536,
    runSeconds: 7_200,
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

/** URL／Host header 用的 authority；IPv6 字面值要加中括號。 */
export function hostAuthority(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
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

/** 0.1 版範本的 baseArgs（權限旗標混在裡面）；讀到就換成新預設，權限改由 fullAccess 決定。 */
const LEGACY_BASE_ARGS: Record<'claude' | 'codex', string> = {
  claude: JSON.stringify(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits']),
  codex: JSON.stringify(['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"']),
};

function cliSection(map: YamlMap, name: 'claude' | 'codex'): CliCommandConfig {
  const s = section(map, name);
  const d = DEFAULT_CONFIG.cli[name];
  const where = `cli.${name}`;
  let baseArgs = strList(s, 'baseArgs', d.baseArgs, where);
  if (JSON.stringify(baseArgs) === LEGACY_BASE_ARGS[name]) baseArgs = d.baseArgs;
  // 0.1 版的 dangerous／dangerousArgs 是自動複製的範本值，不代表使用者選擇，略過
  return {
    command: str(s, 'command', d.command, where),
    baseArgs,
    fullAccess: bool(s, 'fullAccess', d.fullAccess, where),
    fullAccessArgs: strList(s, 'fullAccessArgs', d.fullAccessArgs, where),
    safeArgs: strList(s, 'safeArgs', d.safeArgs, where),
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
      uploadBytes: int(limits, 'uploadBytes', L.uploadBytes, 'limits'),
      imagesPerSend: int(limits, 'imagesPerSend', L.imagesPerSend, 'limits'),
      verifySeconds: int(limits, 'verifySeconds', L.verifySeconds, 'limits'),
      verifyOutputBytes: int(limits, 'verifyOutputBytes', L.verifyOutputBytes, 'limits'),
      runSeconds: int(limits, 'runSeconds', L.runSeconds, 'limits'),
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

/** 設定變更寫回的檔案：目前採用的設定檔；全用預設值時寫到 ~/.yumeewade/config.yaml（下次啟動會讀到）。 */
export function configWriteTarget(config: Config): string {
  return config.source ?? path.join(os.homedir(), '.yumeewade', 'config.yaml');
}

/** 只改寫 workspace.root 那一行，其他設定與註解原樣保留；缺區塊或缺欄位時補上。 */
export function withWorkspaceRoot(text: string, root: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/u);
  const value = yamlScalar(root);
  const start = lines.findIndex(line => /^workspace:\s*(#.*)?$/u.test(line));
  if (start < 0) {
    const head = text === '' || text.endsWith('\n') ? text : text + eol;
    return `${head}workspace:${eol}  root: ${value}${eol}`;
  }
  let at = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^[^\s#]/u.test(line)) break;
    if (/^ +root:(\s|$)/u.test(line)) { at = i; break; }
  }
  if (at < 0) lines.splice(start + 1, 0, `  root: ${value}`);
  else {
    const line = lines[at]!;
    const indent = line.slice(0, line.indexOf('root:'));
    // 行尾註解不含引號才保留，避免把引號值裡的 # 誤當註解
    const comment = /\s+#[^"']*$/u.exec(line.slice(indent.length + 'root:'.length))?.[0] ?? '';
    lines[at] = `${indent}root: ${value}${comment}`;
  }
  return lines.join(eol);
}

/** 把新的工作區根目錄寫回設定檔；寫入前先確認改寫後的內容仍能解析出同一路徑。 */
export async function saveWorkspaceRoot(file: string, root: string): Promise<void> {
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const next = withWorkspaceRoot(text, root);
  if (parseConfig(next, file).workspace.root !== root) throw new ConfigError('workspace.root 寫回後無法讀出相同路徑');
  await atomicWrite(file, next);
}
