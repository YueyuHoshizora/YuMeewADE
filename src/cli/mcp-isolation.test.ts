import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CredentialAccounts } from './accounts.ts';
import { CredentialVault } from '../credentials/vault.ts';

test('Grok and agy seed only config, exclude auth backups, and preserve account MCP edits across leases', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ym-mcp-isolation-')));
  const vault = await CredentialVault.open(path.join(root, 'vault'), { encrypt: async text => Buffer.from(text), decrypt: async bytes => Buffer.from(bytes).toString('utf8'), close: async () => {} });
  const accounts = new CredentialAccounts(vault, path.join(root, 'data'), []);
  try {
    for (const ai of ['grok', 'gemini'] as const) {
      const source = path.join(root, ai);
      const sourceConfig = ai === 'grok' ? source : path.join(source, '.gemini');
      const auth = ai === 'grok' ? path.join(source, 'auth.json') : path.join(sourceConfig, 'antigravity-cli', 'antigravity-oauth-token');
      await fs.mkdir(path.dirname(auth), { recursive: true });
      const record = ai === 'grok' ? JSON.stringify({ server: { auth_mode: 'api_key', key: 'source-secret', user_id: 'one', create_time: '2026-10-01T00:00:00Z' } }) : JSON.stringify({ token: { access_token: 'source-secret', refresh_token: 'refresh-secret' } });
      await fs.writeFile(auth, record);
      await fs.writeFile(path.join(sourceConfig, 'auth.json.backup'), 'backup-secret');
      await fs.writeFile(path.join(sourceConfig, '.credentials.json'), 'other-secret');
      await fs.writeFile(path.join(source, 'unrelated-home-file'), 'must-not-copy-entire-home');
      await fs.writeFile(path.join(sourceConfig, 'mcp-fixture.json'), 'original');
      await accounts.import(ai, source);
      let runtime = '';
      await accounts.withEnv(ai, source, async env => {
        runtime = ai === 'grok' ? env['GROK_HOME']! : path.join(env['HOME']!, '.gemini');
        assert.notEqual(runtime, sourceConfig);
        assert.equal(await fs.readFile(path.join(runtime, 'mcp-fixture.json'), 'utf8'), 'original');
        assert.equal(await fs.stat(path.join(runtime, 'auth.json.backup')).catch(() => null), null);
        assert.equal(await fs.stat(path.join(runtime, '.credentials.json')).catch(() => null), null);
        if (ai === 'gemini') assert.equal(await fs.stat(path.join(env['HOME']!, 'unrelated-home-file')).catch(() => null), null);
        await fs.writeFile(path.join(runtime, 'mcp-fixture.json'), 'saved MCP edit');
      });
      assert.equal(await fs.stat(ai === 'grok' ? path.join(runtime, 'auth.json') : path.join(runtime, 'antigravity-cli', 'antigravity-oauth-token')).catch(() => null), null);
      await fs.writeFile(path.join(sourceConfig, 'mcp-fixture.json'), 'source changed');
      await accounts.withEnv(ai, source, async env => {
        const config = ai === 'grok' ? env['GROK_HOME']! : path.join(env['HOME']!, '.gemini');
        assert.equal(config, runtime);
        assert.equal(await fs.readFile(path.join(config, 'mcp-fixture.json'), 'utf8'), 'saved MCP edit');
      });
      assert.equal(await fs.readFile(auth, 'utf8'), record);
    }
  } finally { await accounts.close(); vault.close(); await fs.rm(root, { recursive: true, force: true }); }
});
