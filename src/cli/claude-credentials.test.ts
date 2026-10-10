import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readClaudeToken } from './claude-credentials.ts';

const credential = (token: string, expiresAt = Date.now() + 60_000) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });

test('Claude 設定目錄對應獨立鑰匙圈，缺少自訂帳戶時絕不讀預設帳戶', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-accounts-'));
  try {
    const work = path.join(root, 'work');
    await fs.mkdir(work);
    await fs.mkdir(path.join(root, '.claude'));
    await fs.writeFile(path.join(root, '.claude', '.credentials.json'), credential('default-only'));
    const services: string[] = [];
    const keychain = async (service: string) => { services.push(service); return service === 'Claude Code-credentials' ? credential('keychain-default') : null; };
    assert.equal(await readClaudeToken({ HOME: root }, keychain), 'keychain-default');
    await assert.rejects(readClaudeToken({ HOME: root, CLAUDE_CONFIG_DIR: work }, keychain), /not found/);
    assert.deepEqual(services, ['Claude Code-credentials', `Claude Code-credentials-${createHash('sha256').update(work).digest('hex').slice(0, 8)}`]);
    await fs.writeFile(path.join(work, '.credentials.json'), credential('work-only'));
    assert.equal(await readClaudeToken({ HOME: root, CLAUDE_CONFIG_DIR: work }, keychain), 'work-only');
    const alias = path.join(root, 'alias');
    await fs.symlink(work, alias);
    const aliasService = `Claude Code-credentials-${createHash('sha256').update(alias).digest('hex').slice(0, 8)}`;
    assert.equal(await readClaudeToken({ CLAUDE_CONFIG_DIR: alias }, async service => service === aliasService ? credential('scoped-alias') : null), 'scoped-alias');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Claude 憑證格式／過期錯誤不洩漏內容，也不回退讀其他帳戶', async () => {
  for (const value of ['secret-invalid-json', 'null', credential('secret-expired', 1), credential('')]) {
    await assert.rejects(readClaudeToken({ CLAUDE_CONFIG_DIR: '/missing-profile' }, async () => value), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^claude credentials (invalid|expired)$/);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
});
