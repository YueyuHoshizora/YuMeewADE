import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { refreshClaudeCredentials } from './claude-refresh.ts';
import { ClaudeQuotaAuthInvalid, fetchClaudeQuota } from './claude.ts';
import { QuotaAuthenticationRequired } from './provider.ts';

const original = {
  unrelated: { apiKeyMetadata: 'kept', nested: [1, 2] },
  claudeAiOauth: {
    accessToken: 'fixture-old-access', refreshToken: 'fixture-old-refresh', expiresAt: 1,
    refreshTokenExpiresAt: 9999, scopes: ['user:profile', 'user:inference'],
    clientId: 'fixture-client', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
    tokenAccount: { uuid: 'old', emailAddress: 'old@example.invalid', extra: 'kept' }, unknown: { keep: true },
  },
};
const text = JSON.stringify(original);

test('Claude refresh uses verified fixed HTTPS protocol and preserves complete rotated metadata', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://platform.claude.com/v1/oauth/token');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' });
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      grant_type: 'refresh_token', refresh_token: 'fixture-old-refresh', client_id: 'fixture-client', scope: 'user:profile user:inference',
    });
    return Response.json({ access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh', expires_in: 3600,
      refresh_token_expires_in: 7200, scope: 'user:profile user:inference user:plugins',
      account: { uuid: 'new', email_address: 'new@example.invalid' }, organization: { uuid: 'org' } });
  };
  assert.deepEqual(JSON.parse(await refreshClaudeCredentials(text, fetcher, () => 1000)), {
    ...original, claudeAiOauth: { ...original.claudeAiOauth, accessToken: 'fixture-new-access', refreshToken: 'fixture-new-refresh',
      expiresAt: 3601000, refreshTokenExpiresAt: 7201000, scopes: ['user:profile', 'user:inference', 'user:plugins'],
      tokenAccount: { uuid: 'new', emailAddress: 'new@example.invalid', organizationUuid: 'org', extra: 'kept' } },
  });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(original), text);
});

test('Claude refresh retains omitted rotation fields but never keeps an old rotated-token expiry', async () => {
  const fetcher: typeof fetch = async () => Response.json({ access_token: 'new', expires_in: 1 });
  assert.deepEqual(JSON.parse(await refreshClaudeCredentials(text, fetcher, () => 1000)).claudeAiOauth,
    { ...original.claudeAiOauth, accessToken: 'new', expiresAt: 2000 });
  const rotated: typeof fetch = async () => Response.json({ access_token: 'new', expires_in: 1, refresh_token: 'rotated' });
  const oauth = JSON.parse(await refreshClaudeCredentials(text, rotated, () => 1000)).claudeAiOauth;
  assert.equal(oauth.refreshToken, 'rotated');
  assert.equal('refreshTokenExpiresAt' in oauth, false);
});

test('Claude definite invalid grants and absent refresh tokens require login, not transient failures', async () => {
  const noRefresh = JSON.stringify({ claudeAiOauth: { accessToken: 'old' } });
  const never: typeof fetch = async () => { assert.fail('no refresh request expected'); };
  await assert.rejects(refreshClaudeCredentials(noRefresh, never), QuotaAuthenticationRequired);
  for (const status of [400, 401]) {
    const invalid: typeof fetch = async () => Response.json({ error: 'invalid_grant', error_description: 'fixture-secret' }, { status });
    await assert.rejects(refreshClaudeCredentials(text, invalid), QuotaAuthenticationRequired);
  }
  const nested: typeof fetch = async () => Response.json({ error: { type: 'invalid_grant' } }, { status: 400 });
  await assert.rejects(refreshClaudeCredentials(text, nested), QuotaAuthenticationRequired);
  for (const status of [400, 401, 403, 429, 500]) {
    const transient: typeof fetch = async () => Response.json({ error: 'invalid_scope', error_description: 'fixture-secret' }, { status });
    await assert.rejects(refreshClaudeCredentials(text, transient), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof QuotaAuthenticationRequired, false);
      assert.equal(error.message, 'claude credential refresh failed');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const held: typeof fetch = async () => Response.json({ error: 'invalid_grant', error_uri: 'https://claude.ai/restricted' }, { status: 400 });
  await assert.rejects(refreshClaudeCredentials(text, held), /^Error: claude credential refresh failed$/);
});

test('Claude malformed, oversized, and transport failures expose no credential or server text', async () => {
  for (const body of [{}, { access_token: 'new', expires_in: 0 }, { access_token: 'new', expires_in: 1e100 },
    { access_token: 'new', expires_in: 1, refresh_token: '' }, { access_token: 'new', expires_in: 1, refresh_token_expires_in: -1 }]) {
    const fetcher: typeof fetch = async () => Response.json(body);
    await assert.rejects(refreshClaudeCredentials(text, fetcher), /^Error: claude credential refresh failed$/);
  }
  const oversized: typeof fetch = async () => new Response('fixture-secret'.repeat(100000));
  const network: typeof fetch = async () => { throw new Error('fixture-old-refresh'); };
  for (const fetcher of [oversized, network]) await assert.rejects(refreshClaudeCredentials(text, fetcher), /^Error: claude credential refresh failed$/);
  await assert.rejects(refreshClaudeCredentials('fixture-secret', network), /^Error: claude credential refresh failed$/);
});

test('Claude usage authentication signal is exclusive to HTTP 401', async () => {
  let status = 401;
  const server = http.createServer((_req, response) => { response.writeHead(status); response.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/usage`;
    await assert.rejects(fetchClaudeQuota({}, 2000, url, async () => 'fixture-access'), ClaudeQuotaAuthInvalid);
    for (status of [403, 500]) await assert.rejects(fetchClaudeQuota({}, 2000, url, async () => 'fixture-access'), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ClaudeQuotaAuthInvalid, false);
      return true;
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
