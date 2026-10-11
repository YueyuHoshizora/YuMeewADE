import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchGrokQuota, grokBillingQuota } from './grok-quota.ts';

const at = '2026-10-11T00:00:00.000Z';
const readCredentials = async () => ({ token: 'test-secret-token', userId: 'test-user-id' });
const billing = (config: Record<string, unknown>) => ({ config });

test('Grok current credit percent includes zero, exhaustion and restored quota', () => {
  for (const percent of [0, 4, 100, 25]) {
    const quota = grokBillingQuota(billing({ creditUsagePercent: percent, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-18T08:00:00+08:00' } }), at);
    assert.deepEqual(quota, { type: 'quota', windows: [{ label: '7d credits', usedPercent: percent, resetsAt: '2026-10-18T00:00:00.000Z' }], limited: percent === 100, at, extraUsage: { unlimited: false, currency: 'USD', balance: 0 } });
  }
});

test('Grok never invents a quota from invalid or absent success fields', () => {
  for (const body of [null, {}, { config: null }, { config: [] }, billing({}), billing({ prepaidBalance: { val: 50 } }), billing({ creditUsagePercent: null }), billing({ creditUsagePercent: '0' }), billing({ creditUsagePercent: -1 }), billing({ creditUsagePercent: 101 }), billing({ creditUsagePercent: NaN }), billing({ creditUsagePercent: Infinity }), billing({ monthlyLimit: {}, used: {} }), billing({ monthlyLimit: { val: 100 } })]) {
    assert.equal(grokBillingQuota(body, at), null);
  }
  assert.equal(grokBillingQuota(billing({ creditUsagePercent: 'bad', monthlyLimit: { val: 100 }, used: {} }), at), null);
});

test('Grok legacy cents zero is explicit, missing is not zero, overages clamp', () => {
  const quota = grokBillingQuota(billing({ monthlyLimit: { val: 200 }, used: {}, billingPeriodEnd: '2026-11-01T00:00:00Z' }), at);
  assert.deepEqual(quota?.windows, [{ label: 'monthly credits', usedPercent: 0, resetsAt: '2026-11-01T00:00:00.000Z' }]);
  assert.equal(grokBillingQuota(billing({ monthlyLimit: { val: 200 }, used: { val: 300 } }), at)?.limited, true);
  for (const val of [-1, '20', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(grokBillingQuota(billing({ monthlyLimit: { val }, used: {} }), at), null);
    assert.equal(grokBillingQuota(billing({ monthlyLimit: { val: 200 }, used: { val } }), at), null);
  }
});

test('Grok period fallback and invalid reset do not invent timestamps', () => {
  assert.equal(grokBillingQuota(billing({ creditUsagePercent: 5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: 'invalid' }, billingPeriodEnd: '2026-11-01T00:00:00Z' }), at)?.windows[0]?.resetsAt, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(grokBillingQuota(billing({ creditUsagePercent: 5, currentPeriod: { type: 'UNKNOWN', end: 123 } }), at)?.windows, [{ label: 'credits', usedPercent: 5, resetsAt: null }]);
});

test('Grok exact purchased balance and explicit on-demand cap preserve remaining credit', () => {
  const exhausted = { creditUsagePercent: 100 };
  assert.equal(grokBillingQuota(billing(exhausted), at)?.prepaidCents, undefined);
  assert.equal(grokBillingQuota(billing({ ...exhausted, prepaidBalance: {} }), at)?.prepaidCents, 0);
  assert.equal(grokBillingQuota(billing({ ...exhausted, prepaidBalance: {} }), at)?.limited, true);
  const prepaid = grokBillingQuota(billing({ ...exhausted, prepaidBalance: { val: 123 } }), at);
  assert.equal(prepaid?.prepaidCents, 123);
  assert.equal(prepaid?.limited, false);
  const capped = grokBillingQuota(billing({ ...exhausted, onDemandCap: { val: 100 }, onDemandUsed: { val: 20 } }), at);
  assert.equal(capped?.windows[1]?.usedPercent, 20);
  assert.equal(capped?.limited, false);
  assert.deepEqual(capped?.extraUsage, { unlimited: false, currency: 'USD', balance: 80 });
  assert.equal(grokBillingQuota(billing({ ...exhausted, onDemandCap: { val: 100 }, onDemandUsed: { val: 100 } }), at)?.limited, true);
  assert.equal(grokBillingQuota(billing({ ...exhausted, onDemandCap: { val: 100 } }), at)?.windows.length, 1);
  assert.equal(grokBillingQuota(billing({ ...exhausted, prepaidBalance: { val: '123' } }), at)?.prepaidCents, undefined);
});

test('Grok authenticated GET uses only verified official endpoint and rejects redirects', async () => {
  let calls = 0;
  const quota = await fetchGrokQuota('/profile', { GROK_CLI_CHAT_PROXY_BASE_URL: 'https://untrusted.invalid' }, {
    readCredentials: async (dir) => { assert.equal(dir, '/profile'); return readCredentials(); },
    transport: async (url, init) => {
      calls++;
      assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.body, undefined);
      assert.ok(init?.signal instanceof AbortSignal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer test-secret-token');
      assert.equal(headers.get('x-userid'), 'test-user-id');
      assert.equal(headers.get('x-xai-token-auth'), 'xai-grok-cli');
      return Response.json(billing({ creditUsagePercent: 0 }));
    },
  });
  assert.equal(calls, 1);
  assert.equal(quota?.windows[0]?.usedPercent, 0);
});

test('Grok missing or API-key-only credentials never perform HTTP', async () => {
  assert.equal(await fetchGrokQuota(undefined, {}, { readCredentials: async () => null, transport: async () => { assert.fail('unexpected request'); } }), null);
});

test('Grok HTTP, redirects, transport and JSON failures never expose sensitive details', async () => {
  for (const status of [302, 401, 403, 429, 500]) {
    await assert.rejects(fetchGrokQuota(undefined, {}, { readCredentials, transport: async () => new Response('test-secret-token echoed body', { status }) }), { message: `Grok billing HTTP ${status}` });
  }
  for (const transport of [async () => { throw new Error('test-secret-token request failure'); }, async () => new Response('test-secret-token malformed JSON'), async () => new Response('x'.repeat(512 * 1024 + 1))]) {
    await assert.rejects(fetchGrokQuota(undefined, {}, { readCredentials, transport }), { message: 'Grok billing query failed' });
  }
  assert.equal(await fetchGrokQuota(undefined, {}, { readCredentials, transport: async () => Response.json({ unexpected: 0 }) }), null);
});

test('Grok timeout covers transport and streaming response body', async (t) => {
  let controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 5); return controller.signal; });
  await assert.rejects(fetchGrokQuota(undefined, {}, { readCredentials, timeoutMs: 5, transport: async (_url, init) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener('abort', () => reject(new Error('test-secret-token timeout')), { once: true });
    queueMicrotask(() => controller.abort());
    return promise;
  } }), { message: 'Grok billing query failed' });
  controller = new AbortController();
  await assert.rejects(fetchGrokQuota(undefined, {}, { readCredentials, timeoutMs: 5, transport: async (_url, init) => new Response(new ReadableStream({ start(stream) {
    init?.signal?.addEventListener('abort', () => stream.error(new Error('test-secret-token stream timeout')), { once: true });
    queueMicrotask(() => controller.abort());
  } })) }), { message: 'Grok billing query failed' });
});
