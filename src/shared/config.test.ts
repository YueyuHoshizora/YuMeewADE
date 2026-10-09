import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, DEFAULT_CONFIG, loadConfig, parseConfig } from './config.ts';

test('空設定等於預設值', () => {
  const c = parseConfig('', null);
  assert.equal(c.server.port, DEFAULT_CONFIG.server.port);
  assert.deepEqual(c.cli.claude, DEFAULT_CONFIG.cli.claude);
  assert.equal(c.workspace.root, path.join(os.homedir(), 'Documents', 'YuMeewWorkspace'));
});

test('部分覆寫與型別驗證', () => {
  const c = parseConfig('server:\n  port: 5000\ncli:\n  codex:\n    dangerous: true\nlimits:\n  queueLength: 3\n', null);
  assert.equal(c.server.port, 5000);
  assert.equal(c.cli.codex.dangerous, true);
  assert.equal(c.cli.claude.dangerous, false);
  assert.equal(c.limits.queueLength, 3);
  assert.throws(() => parseConfig('server:\n  port: abc\n', null), ConfigError);
  assert.throws(() => parseConfig('limits:\n  queueLength: 0\n', null), ConfigError);
  assert.throws(() => parseConfig('cli:\n  claude:\n    baseArgs: -p\n', null), ConfigError);
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
