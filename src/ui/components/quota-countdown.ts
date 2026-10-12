import { t } from '../i18n/index.ts';
import { el } from './dom.ts';

export function formatQuotaDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  return `${Math.floor(minutes / 1_440)}d ${Math.floor(minutes % 1_440 / 60)}h ${minutes % 60}m`;
}

export function resetCountdownText(resetsAt: string, now = Date.now()): string | null {
  const reset = Date.parse(resetsAt);
  if (!Number.isFinite(reset)) return null;
  return countdownText(reset, now);
}

function countdownText(reset: number, now: number): string {
  return reset <= now ? t('usage.resetPending') : t('usage.resetCountdown', { duration: formatQuotaDuration(reset - now) });
}

const bindings = new WeakMap<HTMLElement, { reset: number; update: ((text: string, expired: boolean) => void) | undefined }>();

/** Countdown nodes borrow their owner's timer; detached nodes need no cleanup. */
export function quotaCountdown(resetsAt: string, now = Date.now(), update?: (text: string, expired: boolean) => void): HTMLElement | null {
  const reset = Date.parse(resetsAt);
  if (!Number.isFinite(reset)) return null;
  const node = el('span', 'quota-countdown');
  bindings.set(node, { reset, update });
  updateCountdown(node, now);
  return node;
}

function updateCountdown(node: HTMLElement, now: number): void {
  const binding = bindings.get(node);
  if (!binding) return;
  const text = countdownText(binding.reset, now);
  if (node.textContent !== text) node.textContent = text;
  binding.update?.(text, binding.reset <= now);
}

export function updateQuotaCountdowns(root: ParentNode, now = Date.now()): void {
  for (const node of root.querySelectorAll<HTMLElement>('.quota-countdown')) updateCountdown(node, now);
}
