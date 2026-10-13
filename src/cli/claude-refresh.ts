import { claudeCredentialToken } from './claude-credentials.ts';
import { QuotaAuthenticationRequired } from './provider.ts';

// Verified against Claude Code 2.1.296's OAuth token refresh implementation.
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload', 'user:plugins'];
const MAX_BYTES = 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('claude credential refresh failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('claude credential refresh failed');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Returns the complete rotated record; the account owner must persist it under its credential lease. */
export async function refreshClaudeCredentials(text: string, fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<string> {
  try {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error();
    claudeCredentialToken(text, false);
    const original: unknown = JSON.parse(text);
    if (!record(original) || !record(original['claudeAiOauth'])) throw new Error();
    const oauth = original['claudeAiOauth'];
    if (typeof oauth['refreshToken'] !== 'string' || !oauth['refreshToken'].trim()) throw new QuotaAuthenticationRequired();
    const scopes = Array.isArray(oauth['scopes']) && oauth['scopes'].length > 0 ? oauth['scopes'] : DEFAULT_SCOPES;
    if (!scopes.every(scope => typeof scope === 'string' && scope.trim() && !/\s/u.test(scope))) throw new Error();
    const clientId = oauth['clientId'] ?? CLIENT_ID;
    if (typeof clientId !== 'string' || !clientId.trim()) throw new Error();
    const response = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth['refreshToken'], client_id: clientId, scope: scopes.join(' ') }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) {
      if (response.status === 400 || response.status === 401) {
        const failure = await responseJson(response);
        if (record(failure)) {
          const code = record(failure['error']) ? failure['error']['type'] : failure['error'];
          if (code === 'invalid_grant' && failure['error_uri'] === undefined) throw new QuotaAuthenticationRequired();
        }
      } else await response.body?.cancel().catch(() => {});
      throw new Error();
    }
    const body = await responseJson(response);
    if (!record(body) || typeof body['access_token'] !== 'string' || !body['access_token'].trim() ||
        typeof body['expires_in'] !== 'number' || !Number.isFinite(body['expires_in']) || body['expires_in'] <= 0) throw new Error();
    const timestamp = now();
    const expiresAt = timestamp + body['expires_in'] * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt > 8.64e15 || expiresAt <= timestamp) throw new Error();
    const updated: Record<string, unknown> = { ...oauth, accessToken: body['access_token'], expiresAt };
    if (body['refresh_token'] !== undefined) {
      if (typeof body['refresh_token'] !== 'string' || !body['refresh_token'].trim()) throw new Error();
      updated['refreshToken'] = body['refresh_token'];
      if (body['refresh_token'] !== oauth['refreshToken']) delete updated['refreshTokenExpiresAt'];
    }
    if (body['refresh_token_expires_in'] !== undefined) {
      const duration = body['refresh_token_expires_in'];
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || timestamp + duration * 1000 > 8.64e15) throw new Error();
      updated['refreshTokenExpiresAt'] = timestamp + duration * 1000;
    }
    if (body['scope'] !== undefined) {
      if (typeof body['scope'] !== 'string') throw new Error();
      updated['scopes'] = body['scope'].split(' ').filter(Boolean);
    }
    if (body['account'] !== undefined) {
      if (!record(body['account']) || typeof body['account']['uuid'] !== 'string' || typeof body['account']['email_address'] !== 'string') throw new Error();
      updated['tokenAccount'] = {
        ...(record(oauth['tokenAccount']) ? oauth['tokenAccount'] : {}),
        uuid: body['account']['uuid'], emailAddress: body['account']['email_address'],
        ...(record(body['organization']) && typeof body['organization']['uuid'] === 'string' ? { organizationUuid: body['organization']['uuid'] } : {}),
      };
    }
    return JSON.stringify({ ...original, claudeAiOauth: updated });
  } catch (error) {
    if (error instanceof QuotaAuthenticationRequired) throw error;
    // Network/server messages can contain submitted credentials; never expose their cause.
    throw new Error('claude credential refresh failed');
  }
}
