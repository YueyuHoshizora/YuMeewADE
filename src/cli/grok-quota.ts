// Official contracts: xai-org/grok-build xai-grok-shell/extensions/billing.rs,
// xai-grok-env/lib.rs and xai-grok-login/config.rs. Never accept endpoint overrides.
import { readGrokCredentials } from './grok-credentials.ts';
import type { CliEvent } from './provider.ts';

type QuotaEvent = Extract<CliEvent, { type: 'quota' }>;
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const MAX_BODY_BYTES = 512 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// The upstream Cent protobuf serializes zero as {}, but absent Cent is unknown.
function cents(value: unknown): number | undefined {
  const row = record(value);
  if (!row) return undefined;
  const amount = row['val'] === undefined ? 0 : row['val'];
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

function reset(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Included credits and optional spending cap; never infer an allowance from purchased credits. */
export function grokBillingQuota(value: unknown, at = new Date().toISOString()): QuotaEvent | null {
  const config = record(record(value)?.['config']);
  if (!config) return null;
  let usedPercent: number;
  if (config['creditUsagePercent'] !== undefined) {
    const percent = config['creditUsagePercent'];
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
    usedPercent = percent;
  } else {
    const limit = cents(config['monthlyLimit']);
    const used = cents(config['used']);
    if (limit === undefined || limit <= 0 || used === undefined) return null;
    usedPercent = Math.min(100, used / limit * 100);
  }
  const period = record(config['currentPeriod']);
  const periodType = period?.['type'];
  const label = periodType === 'USAGE_PERIOD_TYPE_WEEKLY' ? '7d credits' : periodType === 'USAGE_PERIOD_TYPE_MONTHLY' || !period && config['creditUsagePercent'] === undefined ? 'monthly credits' : 'credits';
  const resetsAt = reset(period?.['end']) ?? reset(config['billingPeriodEnd']);
  const windows = [{ label, usedPercent, resetsAt }];
  const cap = cents(config['onDemandCap']);
  const onDemandUsed = cents(config['onDemandUsed']);
  if (cap !== undefined && cap > 0 && onDemandUsed !== undefined) {
    windows.push({ label: 'on-demand', usedPercent: Math.min(100, onDemandUsed / cap * 100), resetsAt });
  }
  const prepaidCents = cents(config['prepaidBalance']);
  const limited = usedPercent >= 100 && !(prepaidCents !== undefined && prepaidCents > 0) && !(cap !== undefined && cap > 0 && onDemandUsed !== undefined && onDemandUsed < cap);
  return { type: 'quota', windows, limited, at, ...(prepaidCents !== undefined ? { prepaidCents } : {}) };
}

interface QuotaOptions {
  timeoutMs?: number;
  transport?: typeof fetch;
  readCredentials?: typeof readGrokCredentials;
}

/** Read-only account billing GET. API-key-only accounts have no verified billing endpoint. */
export async function fetchGrokQuota(configDir?: string, env: NodeJS.ProcessEnv = process.env, options: QuotaOptions = {}): Promise<QuotaEvent | null> {
  let response: Response | undefined;
  try {
    const auth = await (options.readCredentials ?? readGrokCredentials)(configDir, env);
    if (!auth) return null;
    response = await (options.transport ?? fetch)(BILLING_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.token}`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-userid': auth.userId, 'x-grok-client-mode': 'headless' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`Grok billing HTTP ${response.status}`);
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new Error('Grok billing response too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return grokBillingQuota(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
  } catch {
    // Transport/JSON errors can include request headers or response bodies. Never propagate them.
    throw new Error(response && !response.ok ? `Grok billing HTTP ${response.status}` : 'Grok billing query failed');
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
