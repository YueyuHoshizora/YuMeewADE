import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ISSUER = 'https://auth.x.ai';
const DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const LEGACY_SCOPE = 'https://accounts.x.ai/sign-in';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read only: never refresh, rewrite, log, or fall back to another profile's auth. */
export async function readGrokCredentials(configDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ token: string; userId: string } | null> {
  // An explicit profile pins auth.json even when the parent process has GROK_AUTH_PATH.
  if (configDir !== undefined && !configDir) return null;
  const home = env['GROK_HOME'] || path.join((process.platform === 'win32' ? env['USERPROFILE'] : env['HOME']) || os.homedir(), '.grok');
  const authPath = configDir !== undefined ? path.join(configDir, 'auth.json') : env['GROK_AUTH_PATH'] || path.join(home, 'auth.json');
  try {
    const store: unknown = JSON.parse(await fs.readFile(authPath, 'utf8'));
    return parseGrokCredentials(store, env);
  } catch {
    return null;
  }
}

export function parseGrokCredentials(store: unknown, env: NodeJS.ProcessEnv = process.env): { token: string; userId: string } | null {
  try {
    if (!record(store)) return null;
    const oidc = env['GROK_OIDC_ISSUER'] !== undefined && env['GROK_OIDC_CLIENT_ID'] !== undefined;
    const oauth = env['GROK_OAUTH2_ISSUER'] !== undefined && env['GROK_OAUTH2_CLIENT_ID'] !== undefined;
    const issuer = oidc ? env['GROK_OIDC_ISSUER']! : oauth ? env['GROK_OAUTH2_ISSUER']! : env['GROK_LOCAL_AUTH'] && env['GROK_LOCAL_AUTH'] !== '0' ? 'http://localhost:22255' : DEFAULT_ISSUER;
    const client = oidc ? env['GROK_OIDC_CLIENT_ID']! : oauth ? env['GROK_OAUTH2_CLIENT_ID']! : DEFAULT_CLIENT_ID;
    // Quota calls go only to production xAI; never send an enterprise/local issuer's token there.
    if (issuer.replace(/\/+$/, '') !== DEFAULT_ISSUER || !client) return null;
    const scope = `${issuer.replace(/\/+$/, '')}::${client}`;
    const auth = Object.hasOwn(store, scope) ? store[scope] : store[LEGACY_SCOPE];
    if (!record(auth) || !['oidc', 'external'].includes(String(auth['auth_mode']))) return null;
    if (auth['oidc_issuer'] !== DEFAULT_ISSUER) return null;
    const token = auth['key'];
    if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) return null;
    const created = timestamp(auth['create_time']);
    if (created === null) return null;
    const expires = auth['expires_at'] == null ? created + TOKEN_TTL_MS : timestamp(auth['expires_at']);
    const now = Date.now();
    if (expires === null || expires <= now) return null;
    let claims: Record<string, unknown> | null = null;
    if (token.split('.').length === 3) {
      const payload = token.split('.')[1]!;
      if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
      const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!record(parsed)) return null;
      claims = parsed;
      if (claims['exp'] !== undefined && (typeof claims['exp'] !== 'number' || !Number.isSafeInteger(claims['exp']) || claims['exp'] * 1000 <= now)) return null;
    }
    // /user enrichment is authoritative; JWT sub is only an identity hint, not signature verification.
    const userId = auth['user_id'] || claims?.['sub'];
    if (typeof userId !== 'string' || !userId.trim() || /[\x00-\x20\x7f]/.test(userId)) return null;
    return { token, userId };
  } catch {
    return null;
  }
}
