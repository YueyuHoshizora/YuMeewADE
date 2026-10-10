import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readGrokCredentials } from './grok-credentials.ts';

const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const legacyScope = 'https://accounts.x.ai/sign-in';
function auth(overrides: Record<string, unknown> = {}) {
  return { key: 'test-token', user_id: 'test-user', auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', create_time: '2090-01-01T00:00:00Z', expires_at: '2091-01-01T00:00:00Z', ...overrides };
}
function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test-signature`;
}

test('Grok profile auth is pinned and never falls back to default files or environment keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-credentials-'));
  try {
    const defaultDir = path.join(root, '.grok');
    const profile = path.join(root, 'work');
    await fs.mkdir(defaultDir);
    await fs.mkdir(profile);
    const defaultFile = path.join(defaultDir, 'auth.json');
    await fs.writeFile(defaultFile, JSON.stringify({ [scope]: auth({ key: 'default-token' }) }));
    const env = { HOME: root, USERPROFILE: root, GROK_HOME: defaultDir, GROK_AUTH_PATH: defaultFile, XAI_API_KEY: 'ambient-key' };
    assert.deepEqual(await readGrokCredentials(undefined, env), { token: 'default-token', userId: 'test-user' });
    assert.equal(await readGrokCredentials(profile, env), null);
    assert.equal(await readGrokCredentials('', env), null);
    const file = path.join(profile, 'auth.json');
    await fs.writeFile(file, JSON.stringify({ [scope]: auth({ key: 'profile-token', user_id: 'profile-user' }) }));
    const before = await fs.readFile(file, 'utf8');
    assert.deepEqual(await readGrokCredentials(profile, env), { token: 'profile-token', userId: 'profile-user' });
    assert.equal(await fs.readFile(file, 'utf8'), before);
    await fs.writeFile(file, 'malformed-private-content');
    assert.equal(await readGrokCredentials(profile, env), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Grok default home, auth-path overrides and scope selection follow official storage rules', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-credentials-'));
  try {
    const home = path.join(root, '.grok');
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ [scope]: auth(), [legacyScope]: auth({ key: 'legacy-token' }) }));
    assert.deepEqual(await readGrokCredentials(undefined, { HOME: root, USERPROFILE: root, GROK_HOME: '', GROK_AUTH_PATH: '' }), { token: 'test-token', userId: 'test-user' });
    const override = path.join(root, 'custom-auth.json');
    await fs.writeFile(override, JSON.stringify({ [legacyScope]: auth({ key: 'legacy-token' }) }));
    assert.deepEqual(await readGrokCredentials(undefined, { GROK_AUTH_PATH: override }), { token: 'legacy-token', userId: 'test-user' });
    const customScope = 'https://auth.x.ai::custom-client';
    await fs.writeFile(override, JSON.stringify({ [scope]: auth(), [customScope]: auth({ key: 'custom-token' }) }));
    const env = { GROK_AUTH_PATH: override, GROK_OAUTH2_ISSUER: 'https://auth.x.ai/', GROK_OAUTH2_CLIENT_ID: 'custom-client' };
    assert.deepEqual(await readGrokCredentials(undefined, env), { token: 'custom-token', userId: 'test-user' });
    assert.equal(await readGrokCredentials(undefined, { ...env, GROK_OIDC_ISSUER: 'https://enterprise.example', GROK_OIDC_CLIENT_ID: 'enterprise' }), null);
    await fs.writeFile(override, JSON.stringify({ [scope]: auth({ key: '' }), [legacyScope]: auth() }));
    assert.equal(await readGrokCredentials(undefined, { GROK_AUTH_PATH: override }), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Grok malformed, unsupported and expired records fail closed without credential errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-credentials-'));
  try {
    const file = path.join(root, 'auth.json');
    const invalid = [null, [], {}, auth({ key: '' }), auth({ key: 'private\nheader' }), auth({ user_id: 12 }), auth({ user_id: 'bad\rheader' }), auth({ user_id: '' }), auth({ auth_mode: 'api_key' }), auth({ auth_mode: 'web_login' }), auth({ auth_mode: 'grok' }), auth({ oidc_issuer: 'https://enterprise.example' }), auth({ create_time: 'invalid' }), auth({ expires_at: 'invalid' }), auth({ expires_at: 9999999999999 }), auth({ expires_at: '2000-01-01T00:00:00Z' }), auth({ create_time: '2000-01-01T00:00:00Z', expires_at: null }), auth({ key: jwt({ exp: 1, sub: 'test-user' }) }), auth({ key: jwt({ exp: '9999999999' }) }), auth({ key: 'header.bad-payload.signature' })];
    for (const entry of invalid) {
      await fs.writeFile(file, JSON.stringify({ [scope]: entry }));
      assert.equal(await readGrokCredentials(root, { XAI_API_KEY: 'not-a-fallback' }), null);
    }
    for (const text of ['private-invalid-json', 'null', '[]', '', '{"xai::api_key":{"key":"private-key"}}']) {
      await fs.writeFile(file, text);
      assert.equal(await readGrokCredentials(root, {}), null);
    }
    await fs.rm(file);
    assert.equal(await readGrokCredentials(root, {}), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Grok JWT expiry is checked and stored /user identity wins over unverified JWT subject', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-credentials-'));
  try {
    const token = jwt({ sub: 'jwt-user', exp: 3818448000, aud: ['grok'] });
    const file = path.join(root, 'auth.json');
    await fs.writeFile(file, JSON.stringify({ [scope]: auth({ key: token, user_id: 'enriched-user' }) }));
    assert.deepEqual(await readGrokCredentials(root, {}), { token, userId: 'enriched-user' });
    await fs.writeFile(file, JSON.stringify({ [scope]: auth({ key: token, user_id: '', expires_at: null }) }));
    assert.deepEqual(await readGrokCredentials(root, {}), { token, userId: 'jwt-user' });
    await fs.writeFile(file, JSON.stringify({ [scope]: auth({ key: 'opaque-token', auth_mode: 'external' }) }));
    assert.deepEqual(await readGrokCredentials(root, {}), { token: 'opaque-token', userId: 'test-user' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
