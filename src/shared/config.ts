// config.yaml 載入與驗證。讀取順序：YUMEEWADE_CONFIG → ./config.yaml → ~/.yumeewade/config.yaml → 內建預設。
// 所有 host／port／路徑／CLI 旗標／上限值都在這裡進來，程式其他地方不得寫死。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from './fsx.ts';
import { parseYamlMap, yamlScalar, type YamlMap, type YamlValue } from './yaml.ts';

export interface CliCommandConfig {
  command: string;
  /** Codex ordinary conversation transport; readonly remains its dedicated invocation. */
  mode?: 'app-server' | 'exec';
  appServerArgs?: string[];
  /** 無頭模式必要旗標（adapter 依此解析輸出）。 */
  baseArgs: string[];
  /** 預設是否跳過權限確認；設定頁可逐一覆寫（.yumeewade/settings.json）。 */
  fullAccess: boolean;
  fullAccessArgs: string[];
  /** fullAccess 關閉時改用的權限旗標。 */
  safeArgs: string[];
  approvalArgs?: string[];
  /** Dedicated review invocation; never combined with ordinary permission/base arguments. Empty disables review. */
  readonlyArgs?: string[];
  /** 查詢帳號額度的子命令（Codex：app-server）；直接使用 API 的 adapter 不需要子命令。 */
  quotaArgs: string[];
  /** 已存憑證的存取權杖過期時，在帳號租用環境中執行、讓 CLI 自行換發權杖的唯讀子命令；空陣列表示不換發。 */
  authRefreshArgs: string[];
  /** 新增帳號時在獨立設定資料夾內執行的 OAuth 登入子命令（由 CLI 自行開啟瀏覽器）。 */
  loginArgs: string[];
  /** 唯讀命令清單查詢（Gemini：print /help）。 */
  commandsArgs: string[];
  /** 獨立唯讀 slash 執行旗標；命令文字作為最後一個參數。 */
  slashArgs: string[];
  mcpListArgs?: string[];
  mcpAddArgs?: string[];
  mcpRemoveArgs?: string[];
}

export interface NativeToolConfig { command: string; args: string[] }

export interface Config {
  server: { host: string; port: number };
  workspace: { root: string };
  /** 檢查 GitHub 發行頁有沒有新版本（只通知，不自動安裝）。 */
  update: { enabled: boolean; repo: string; checkHours: number };
  execution: { ide?: NativeToolConfig; terminal?: NativeToolConfig; browser?: NativeToolConfig };
  cli: { claude: CliCommandConfig; codex: CliCommandConfig; grok: CliCommandConfig; gemini: CliCommandConfig; envPassthrough: string[] };
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
    approvalSeconds?: number;
    usagePollSeconds: number;
    mentionFileBytes: number;
    mentionTotalBytes: number;
  };
  /** 實際採用的設定檔路徑；null＝全部用預設值。 */
  source: string | null;
}

export const DEFAULT_CONFIG: Config = {
  server: { host: '127.0.0.1', port: 4560 },
  workspace: { root: '~/Documents/YuMeewWorkspace' },
  update: { enabled: true, repo: 'YueyuHoshizora/YuMeewADE', checkHours: 6 },
  execution: {},
  cli: {
    claude: {
      command: 'claude',
      baseArgs: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
      fullAccess: true,
      fullAccessArgs: ['--dangerously-skip-permissions'],
      // 手動模式將需核准的工具交給主程式；不自動接受編輯。
      safeArgs: ['--permission-mode', 'manual'],
      approvalArgs: ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
      readonlyArgs: ['--restricted', '--safe-mode', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
      quotaArgs: [],
      authRefreshArgs: ['-p', '/usage', '--output-format', 'json'],
      loginArgs: ['auth', 'login'],
      commandsArgs: [],
      slashArgs: [],
      mcpListArgs: ['mcp', 'list'],
      mcpAddArgs: ['mcp', 'add', '--scope', 'user'],
      mcpRemoveArgs: ['mcp', 'remove', '--scope', 'user'],
    },
    codex: {
      command: 'codex',
      mode: 'app-server',
      appServerArgs: ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"'],
      baseArgs: ['exec', '--json', '--skip-git-repo-check'],
      fullAccess: true,
      fullAccessArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      // 工作目錄沙箱內可改檔與執行指令，不詢問
      safeArgs: ['-s', 'workspace-write', '-c', 'approval_policy="never"'],
      readonlyArgs: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--ignore-user-config', '--ignore-rules', '--ephemeral'],
      quotaArgs: ['app-server'],
      authRefreshArgs: [],
      loginArgs: ['login', '-c', 'cli_auth_credentials_store="file"'],
      commandsArgs: [],
      slashArgs: [],
      mcpListArgs: ['mcp', 'list', '--json'],
      mcpAddArgs: ['mcp', 'add'],
      mcpRemoveArgs: ['mcp', 'remove'],
    },
    grok: {
      command: 'grok',
      baseArgs: ['--output-format', 'streaming-json'],
      fullAccess: true,
      fullAccessArgs: ['--always-approve'],
      // 需要互動核准的操作直接拒絕，不讓無頭回合等待輸入。
      safeArgs: ['--permission-mode', 'dontAsk'],
      readonlyArgs: [],
      quotaArgs: [],
      authRefreshArgs: ['models'],
      loginArgs: ['login', '--oauth'],
      commandsArgs: [],
      slashArgs: [],
      mcpListArgs: ['mcp', 'list', '--json'],
      mcpAddArgs: ['mcp', 'add', '--scope', 'user'],
      mcpRemoveArgs: ['mcp', 'remove', '--scope', 'user'],
    },
    // Google 官方後繼：Antigravity CLI（agy）。提示經 stdin 的 stream-json 傳入，沒有 argv 外洩。
    gemini: {
      command: 'agy',
      baseArgs: ['--output-format', 'stream-json', '--input-format', 'stream-json', '--print='],
      fullAccess: true,
      fullAccessArgs: ['--dangerously-skip-permissions'],
      // 只自動接受檔案編輯；其他操作不讓無頭回合等待互動核准。
      safeArgs: ['--mode', 'accept-edits'],
      readonlyArgs: [],
      quotaArgs: ['-p', '/usage', '--output-format', 'json'],
      authRefreshArgs: [],
      loginArgs: [],
      commandsArgs: ['-p', '/help', '--output-format', 'json'],
      slashArgs: ['--output-format', 'json', '--print'],
      mcpListArgs: ['mcp', 'list'],
      mcpAddArgs: ['mcp', 'add'],
      mcpRemoveArgs: ['mcp', 'remove'],
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
    approvalSeconds: 120,
    usagePollSeconds: 60,
    mentionFileBytes: 65_536,
    mentionTotalBytes: 262_144,
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

function repoName(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new ConfigError('update.repo 必須是「擁有者/倉庫」格式');
  return value;
}

function strList(map: YamlMap, key: string, fallback: string[], where: string): string[] {
  const v: YamlValue | undefined = map[key];
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ConfigError(`${where}.${key} 必須是字串清單`);
  return v as string[];
}

function mcpArgs(map: YamlMap, key: string, fallback: string[], where: string): string[] {
  const args = strList(map, key, fallback, where);
  if (args.length > 128 || args.some(arg => arg.length > 8192 || /[\0\r\n]/u.test(arg))) throw new ConfigError(`${where}.${key} 無效`);
  return args;
}
/** 0.1 版範本的 baseArgs（權限旗標混在裡面）；讀到就換成新預設，權限改由 fullAccess 決定。 */
const LEGACY_BASE_ARGS: Record<'claude' | 'codex', string> = {
  claude: JSON.stringify(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits']),
  codex: JSON.stringify(['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"']),
};

function cliSection(map: YamlMap, name: 'claude' | 'codex' | 'grok' | 'gemini'): CliCommandConfig {
  const s = section(map, name);
  const d = DEFAULT_CONFIG.cli[name];
  const where = `cli.${name}`;
  let baseArgs = strList(s, 'baseArgs', d.baseArgs, where);
  if ((name === 'claude' || name === 'codex') && JSON.stringify(baseArgs) === LEGACY_BASE_ARGS[name]) baseArgs = d.baseArgs;
  const mode = str(s, 'mode', d.mode ?? 'exec', where);
  if (mode !== 'app-server' && mode !== 'exec') throw new ConfigError(`${where}.mode 必須是 app-server 或 exec`);
  const appServerArgs = mcpArgs(s, 'appServerArgs', d.appServerArgs ?? [], where);
  if (name === 'codex' && mode === 'app-server' && (appServerArgs[0] !== 'app-server' || !appServerArgs.includes('--stdio') || appServerArgs.some(arg => /^(--listen|--code-mode-host|--ws-|proxy|daemon)/u.test(arg)))) throw new ConfigError(`${where}.appServerArgs 必須使用本機 stdio`);
  // 0.1 版的 dangerous／dangerousArgs 是自動複製的範本值，不代表使用者選擇，略過
  return {
    command: str(s, 'command', d.command, where),
    ...(name === 'codex' ? { mode: mode as 'app-server' | 'exec', appServerArgs } : {}),
    baseArgs,
    fullAccess: bool(s, 'fullAccess', d.fullAccess, where),
    fullAccessArgs: strList(s, 'fullAccessArgs', d.fullAccessArgs, where),
    safeArgs: strList(s, 'safeArgs', d.safeArgs, where),
    approvalArgs: strList(s, 'approvalArgs', d.approvalArgs ?? [], where),
    readonlyArgs: strList(s, 'readonlyArgs', d.readonlyArgs ?? [], where),
    quotaArgs: strList(s, 'quotaArgs', d.quotaArgs, where),
    authRefreshArgs: strList(s, 'authRefreshArgs', d.authRefreshArgs, where),
    loginArgs: strList(s, 'loginArgs', d.loginArgs, where),
    commandsArgs: strList(s, 'commandsArgs', d.commandsArgs, where),
    slashArgs: strList(s, 'slashArgs', d.slashArgs, where),
    mcpListArgs: mcpArgs(s, 'mcpListArgs', d.mcpListArgs ?? [], where),
    mcpAddArgs: mcpArgs(s, 'mcpAddArgs', d.mcpAddArgs ?? [], where),
    mcpRemoveArgs: mcpArgs(s, 'mcpRemoveArgs', d.mcpRemoveArgs ?? [], where),
  };
}

function executionSection(map: YamlMap): Config['execution'] {
  const source = section(map, 'execution');
  const result: Config['execution'] = {};
  for (const key of Object.keys(source)) if (!['ide', 'terminal', 'browser'].includes(key)) throw new ConfigError('execution 含未知欄位');
  for (const key of ['ide', 'terminal', 'browser'] as const) {
    if (source[key] === undefined) continue;
    const tool = section(source, key);
    if (Object.keys(tool).some(field => field !== 'command' && field !== 'args')) throw new ConfigError(`execution.${key} 含未知欄位`);
    const command = str(tool, 'command', '', `execution.${key}`);
    const args = strList(tool, 'args', [], `execution.${key}`);
    const placeholder = key === 'browser' ? '{url}' : '{cwd}';
    if (!command || command.includes('\0') || command.length > 8192 || args.length > 128
      || args.some(arg => arg.includes('\0') || arg.length > 8192) || !args.some(arg => arg.includes(placeholder))) {
      throw new ConfigError(`execution.${key} 指令或參數不合法，必須包含 ${placeholder}`);
    }
    result[key] = { command, args };
  }
  return result;
}

/** 把 YAML 內容套在預設值上並驗證。 */
export function parseConfig(text: string, source: string | null): Config {
  const map = parseYamlMap(text);
  const server = section(map, 'server');
  const workspace = section(map, 'workspace');
  const update = section(map, 'update');
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
    update: {
      enabled: bool(update, 'enabled', d.update.enabled, 'update'),
      repo: repoName(str(update, 'repo', d.update.repo, 'update')),
      checkHours: int(update, 'checkHours', d.update.checkHours, 'update'),
    },
    execution: executionSection(map),
    cli: {
      claude: cliSection(cli, 'claude'),
      codex: cliSection(cli, 'codex'),
      grok: cliSection(cli, 'grok'),
      gemini: cliSection(cli, 'gemini'),
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
      mentionFileBytes: int(limits, 'mentionFileBytes', L.mentionFileBytes, 'limits'),
      mentionTotalBytes: int(limits, 'mentionTotalBytes', L.mentionTotalBytes, 'limits'),
      approvalSeconds: int(limits, 'approvalSeconds', L.approvalSeconds ?? 120, 'limits'),
      usagePollSeconds: int(limits, 'usagePollSeconds', L.usagePollSeconds, 'limits'),
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
export function withWorkspaceRoot(original: string, root: string): string {
  // A byte order mark would keep an existing first-line `workspace:` from matching and a second section would be appended.
  const text = original.replace(/^\uFEFF/, '');
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
