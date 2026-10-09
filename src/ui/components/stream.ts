import { t } from '../i18n/index.ts';
import { el } from './dom.ts';

const disconnected = new Set<symbol>();
let indicator: HTMLElement | null = null;
export function stream(url: string, listeners: Record<string, (event: MessageEvent<string>) => void>, onOpen?: () => void): { close(): void } {
  const key = Symbol(url); let source: EventSource; let retry = 0; let delay = 1000; let closed = false;
  function status(failed: boolean): void {
    if (failed) disconnected.add(key); else disconnected.delete(key);
    if (!indicator) { indicator = el('div', 'connection-status'); indicator.setAttribute('role', 'status'); document.body.append(indicator); }
    indicator.textContent = t('connection.reconnecting'); indicator.hidden = !disconnected.size;
  }
  function connect(): void {
    if (closed) return;
    source = new EventSource(url);
    for (const [name, listener] of Object.entries(listeners)) source.addEventListener(name, event => listener(event as MessageEvent<string>));
    source.onopen = () => { delay = 1000; status(false); onOpen?.(); };
    source.onerror = () => {
      status(true);
      if (source.readyState === EventSource.CLOSED && !retry) { source.close(); retry = window.setTimeout(() => { retry = 0; connect(); }, delay); delay = Math.min(30_000, delay * 2); }
    };
  }
  connect();
  return { close: () => { closed = true; source.close(); window.clearTimeout(retry); status(false); } };
}
