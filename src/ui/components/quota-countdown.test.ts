import assert from 'node:assert/strict';
import test from 'node:test';

class Element {
  textContent = '';
  className = '';
}
Object.defineProperty(globalThis, 'document', { value: { createElement: () => new Element() }, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true });
// Static imports would initialize the locale before its browser-global fixtures exist.
const { formatQuotaDuration, resetCountdownText, quotaCountdown, updateQuotaCountdowns } = await import('./quota-countdown.ts');
const { t } = await import('../i18n/index.ts');

test('quota duration rounds up to minutes using fixed English d h m units', () => {
  assert.equal(formatQuotaDuration(0), '0d 0h 0m');
  assert.equal(formatQuotaDuration(1), '0d 0h 1m');
  assert.equal(formatQuotaDuration(60_001), '0d 0h 2m');
  assert.equal(formatQuotaDuration(90_060_000), '1d 1h 1m');
  assert.equal(formatQuotaDuration(3_600_000), '0d 1h 0m');
  assert.equal(formatQuotaDuration(86_400_000), '1d 0h 0m');
});

test('missing or invalid resets have no countdown and elapsed resets await quota refresh', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  assert.equal(resetCountdownText('', now), null);
  assert.equal(resetCountdownText('invalid', now), null);
  assert.equal(quotaCountdown('invalid', now), null);
  assert.equal(resetCountdownText('2026-10-11T23:59:59Z', now), t('usage.resetPending'));
  assert.equal(resetCountdownText('2026-10-12T00:00:00Z', now), t('usage.resetPending'));
  assert.equal(resetCountdownText('2026-10-12T00:00:00.001Z', now), t('usage.resetCountdown', { duration: formatQuotaDuration(1) }));
});

test('owner ticks update the same countdown node and notify stale rendering at expiry', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  const updates: { text: string; expired: boolean }[] = [];
  const node = quotaCountdown('2026-10-12T00:02:00Z', now, (text, expired) => updates.push({ text, expired }))!;
  const root = { querySelectorAll: () => [node] } as unknown as ParentNode;
  const initial = node.textContent;
  updateQuotaCountdowns(root, now + 60_000);
  assert.notEqual(node.textContent, initial);
  assert.equal(updates.at(-1)?.expired, false);
  updateQuotaCountdowns(root, now + 120_000);
  assert.equal(node.textContent, t('usage.resetPending'));
  assert.deepEqual(updates.at(-1), { text: t('usage.resetPending'), expired: true });
  updateQuotaCountdowns(root, now + 140_000);
  assert.equal(node.textContent, t('usage.resetPending'));
});
