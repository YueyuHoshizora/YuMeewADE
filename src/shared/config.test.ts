import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, DEFAULT_CONFIG, loadConfig, parseConfig, withWorkspaceRoot } from './config.ts';

test('空設定等於預設值', () => {
  const c = parseConfig('', null);
  assert.equal(c.server.port, DEFAULT_CONFIG.server.port);
  assert.deepEqual(c.cli.claude, DEFAULT_CONFIG.cli.claude);
  assert.equal(c.workspace.root, path.join(os.homedir(), 'Documents', 'YuMeewWorkspace'));
});

test('Codex defaults to local app-server and accepts explicit exec only', () => {
  assert.equal(parseConfig('', null).cli.codex.mode, 'app-server');
  assert.equal(parseConfig('cli:\n  codex:\n    mode: exec\n', null).cli.codex.mode, 'exec');
  for (const override of ['mode: hybrid', 'appServerArgs: [app-server, --stdio, --listen, ws://127.0.0.1:1]', 'appServerArgs: [app-server, --stdio, --code-mode-host, https://example.com]', 'appServerArgs: [app-server, proxy]']) assert.throws(() => parseConfig(`cli:\n  codex:\n    ${override}\n`, null), ConfigError);
  assert.equal(parseConfig('', null).cli.codex.fullAccess, true);
});

test('部分覆寫與型別驗證', () => {
  const c = parseConfig('server:\n  port: 5000\ncli:\n  codex:\n    fullAccess: false\nlimits:\n  queueLength: 3\n', null);
  assert.equal(c.server.port, 5000);
  assert.equal(c.cli.codex.fullAccess, false);
  assert.equal(c.cli.claude.fullAccess, true);
  assert.equal(c.limits.queueLength, 3);
  assert.throws(() => parseConfig('server:\n  port: abc\n', null), ConfigError);
  assert.throws(() => parseConfig('limits:\n  queueLength: 0\n', null), ConfigError);
  assert.throws(() => parseConfig('cli:\n  claude:\n    baseArgs: -p\n', null), ConfigError);
});

test('0.1 版範本的 baseArgs 換成新預設，權限旗標不再混在裡面', () => {
  const legacy = [
    'cli:',
    '  claude:',
    '    baseArgs: [-p, --output-format, stream-json, --verbose, --include-partial-messages, --permission-mode, acceptEdits]',
    '    dangerous: false',
    '  codex:',
    `    baseArgs: [exec, --json, --skip-git-repo-check, -s, workspace-write, -c, 'approval_policy="never"']`,
  ].join('\n');
  const c = parseConfig(legacy, null);
  assert.deepEqual(c.cli.claude.baseArgs, DEFAULT_CONFIG.cli.claude.baseArgs);
  assert.deepEqual(c.cli.codex.baseArgs, DEFAULT_CONFIG.cli.codex.baseArgs);
  assert.equal(c.cli.claude.fullAccess, true);
  // 自訂過的 baseArgs 不動
  assert.deepEqual(parseConfig('cli:\n  claude:\n    baseArgs: [-p, --output-format, stream-json, --verbose]\n', null).cli.claude.baseArgs, ['-p', '--output-format', 'stream-json', '--verbose']);
});

test('非 loopback host 被拒絕', () => {
  assert.throws(() => parseConfig('server:\n  host: 0.0.0.0\n', null), /只允許 127\.0\.0\.1/);
});

test('loadConfig 依序找檔，找不到用預設', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-config-'));
  try {
    const none = await loadConfig({}, dir);
    assert.equal(none.source, null);
    await fs.writeFile(path.join(dir, 'config.yaml'), 'server:\n  port: 4999\n');
    const fromCwd = await loadConfig({}, dir);
    assert.equal(fromCwd.server.port, 4999);
    const custom = path.join(dir, 'other.yaml');
    await fs.writeFile(custom, 'server:\n  port: 4777\n');
    const fromEnv = await loadConfig({ YUMEEWADE_CONFIG: custom }, dir);
    assert.equal(fromEnv.server.port, 4777);
    assert.equal(fromEnv.source, custom);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('withWorkspaceRoot 只改 root 那一行：保留註解與其他區塊，特殊字元路徑可讀回', () => {
  const text = '# 頂部註解\nserver:\n  port: 4999\n\nworkspace:\n  # 區塊內註解\n  root: ~/Old   # 根目錄說明\n  # 結構說明\n\ncli:\n  envPassthrough: [A]\n';
  for (const root of ['/Users/me/My Work', '/tmp/a #b', 'C:\\Users\\me\\工作區', '/tmp/x: y', '/tmp/"q"']) {
    const next = withWorkspaceRoot(text, root);
    const c = parseConfig(next, null);
    assert.equal(c.workspace.root, root);
    assert.equal(c.server.port, 4999);
    assert.deepEqual(c.cli.envPassthrough, ['A']);
    assert.deepEqual(next.split('\n').filter(l => !/^ +root:/u.test(l)), text.split('\n').filter(l => !/^ +root:/u.test(l)));
  }
  assert.match(withWorkspaceRoot(text, '/plain'), /^ {2}root: \/plain {3}# 根目錄說明$/mu);
});

test('withWorkspaceRoot 缺 workspace 區塊或缺 root 時補上，保留 CRLF', () => {
  assert.equal(parseConfig(withWorkspaceRoot('', '/a'), null).workspace.root, '/a');
  assert.equal(parseConfig(withWorkspaceRoot('server:\n  port: 4999', '/b'), null).workspace.root, '/b');
  const crlf = withWorkspaceRoot('workspace:\r\n  # 尚未設定\r\nlimits:\r\n  queueLength: 5\r\n', '/c');
  assert.ok(!/[^\r]\n/u.test(crlf));
  const c = parseConfig(crlf, null);
  assert.equal(c.workspace.root, '/c');
  assert.equal(c.limits.queueLength, 5);
});

test('limits.runSeconds 預設 2 小時，可覆寫，且必須是正整數', () => {
  assert.equal(parseConfig('', null).limits.runSeconds, 7200);
  assert.equal(parseConfig('limits:\n  runSeconds: 90\n', null).limits.runSeconds, 90);
  for (const bad of ['0', '-5', '1.5', 'never']) assert.throws(() => parseConfig(`limits:\n  runSeconds: ${bad}\n`, null), ConfigError);
});

test('timer-backed settings refuse values past what a Node timer can hold, instead of firing every millisecond', () => {
  // 2^31−1 ms is about 24.8 days: 596 hours and 2147482 seconds are the largest accepted values.
  assert.equal(parseConfig('update:\n  checkHours: 596\n', null).update.checkHours, 596);
  assert.equal(parseConfig('limits:\n  usagePollSeconds: 2147482\n', null).limits.usagePollSeconds, 2147482);
  assert.throws(() => parseConfig('update:\n  checkHours: 720\n', null), (error: unknown) => error instanceof ConfigError && error.message.startsWith('update.checkHours '));
  for (const key of ['usagePollSeconds', 'runSeconds', 'verifySeconds', 'approvalSeconds', 'heartbeatSeconds']) {
    assert.throws(() => parseConfig(`limits:\n  ${key}: 2592000\n`, null), (error: unknown) => error instanceof ConfigError && error.message.startsWith(`limits.${key} `), key);
  }
});

test('native integrations preserve argv and reject missing destinations or invalid configuration', () => {
  const config = parseConfig("execution:\n  ide: { command: code, args: ['--wait', '{cwd}'] }\n  browser: { command: chromium, args: ['{url}'] }\n", null);
  assert.deepEqual(config.execution.ide, { command: 'code', args: ['--wait', '{cwd}'] });
  assert.deepEqual(config.execution.browser, { command: 'chromium', args: ['{url}'] });
  for (const text of [
    'execution:\n  surprise: {}\n',
    'execution:\n  ide: { command: code, args: [] }\n',
    "execution:\n  browser: { command: chromium, args: ['{cwd}'] }\n",
    "execution:\n  terminal: { command: terminal, args: ['{cwd}'], shell: true }\n",
    "execution:\n  ide: { command: code, args: [1, '{cwd}'] }\n",
  ]) assert.throws(() => parseConfig(text, null), ConfigError);
});

test('switching the workspace root in a config saved with a byte order mark keeps a single workspace section', () => {
  const next = withWorkspaceRoot('\uFEFFworkspace:\n  root: /old\nserver:\n  port: 4561\n', '/new');
  const config = parseConfig(next, '/tmp/config.yaml');
  assert.equal(config.workspace.root, '/new');
  assert.equal(config.server.port, 4561);
});

test('switching the workspace root rewrites a quoted or inline workspace section instead of adding a duplicate', () => {
  for (const text of ['workspace: { root: "/old" }\nserver:\n  port: 4561\n', '"workspace":\n  root: "/old"\nserver:\n  port: 4561\n', "workspace:\n  'root': /old # moved\nserver:\n  port: 4561\n"]) {
    const next = withWorkspaceRoot(text, '/new');
    const config = parseConfig(next, '/tmp/config.yaml');
    assert.equal(config.workspace.root, '/new', text); assert.equal(config.server.port, 4561);
    assert.equal(next.match(/workspace/gu)?.length, 1, next);
  }
});

test('misspelled keys are rejected instead of silently falling back to defaults', () => {
  for (const [text, key] of [
    ['cli:\n  codex:\n    fullAcess: false\n', 'cli.codex.fullAcess'],
    ['cli:\n  cluade:\n    fullAccess: false\n', 'cli.cluade'],
    ['limits:\n  sendPerMinut: 1\n', 'limits.sendPerMinut'],
    ['server:\n  hots: 127.0.0.1\n', 'server.hots'],
    ['servers:\n  port: 1\n', 'servers'],
    // `__proto__` is just an unknown key, never a way to inject inherited settings.
    ['__proto__: { server: { port: 4999 } }\n', '__proto__'],
    ['server:\n  __proto__:\n    port: 1\n', 'server.__proto__'],
    ['execution:\n  surprise: {}\n', 'execution.surprise'],
    ["execution:\n  ide: { command: code, args: ['{cwd}'], argz: [] }\n", 'execution.ide.argz'],
  ] as const) {
    assert.throws(() => parseConfig(text, null), (error: unknown) => error instanceof ConfigError && error.message.startsWith(`${key} `), key);
  }
  // Keys written by the 0.1 template stay accepted and ignored.
  assert.equal(parseConfig('cli:\n  codex:\n    dangerous: true\n    dangerousArgs: [--yolo]\n', null).cli.codex.fullAccess, DEFAULT_CONFIG.cli.codex.fullAccess);
});
