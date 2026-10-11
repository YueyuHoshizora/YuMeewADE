import type { TerminalRecoveryLease, TerminalRecoveryList, TerminalRecoveryTab } from '../../shared/types.ts';
import { request } from '../api.ts';

interface Stored { renderer: string; generation: string; tickets: Record<string, string> }
const key = 'yumeewade.terminalRecovery';
let stored: Stored | undefined;
let ready: Promise<void> | undefined;
function save(): void { sessionStorage.setItem(key, JSON.stringify(stored)); }
export async function initializeTerminalRecovery(): Promise<void> {
  ready ??= (async () => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (value && typeof value === 'object' && 'renderer' in value && typeof value.renderer === 'string' && /^[a-f0-9]{64}$/u.test(value.renderer) && 'generation' in value && typeof value.generation === 'string' && 'tickets' in value && value.tickets && typeof value.tickets === 'object' && !Array.isArray(value.tickets)) {
        const tickets: Record<string, string> = {};
        for (const [id, ticket] of Object.entries(value.tickets).slice(0, 64)) if (/^[a-f0-9-]{36}$/u.test(id) && typeof ticket === 'string' && /^[a-f0-9]{64}$/u.test(ticket)) tickets[id] = ticket;
        stored = { renderer: value.renderer, generation: value.generation, tickets };
      }
    } catch { /* Corrupt metadata cannot grant a lease. */ }
    stored ??= { renderer: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''), generation: '', tickets: {} };
    const state = stored;
    const result = await request<{ generation: string }>('/api/terminal/recovery/init', {});
    if (state !== stored) throw new Error('Recovery scope changed');
    if (stored.generation && stored.generation !== result.generation && Object.keys(stored.tickets).length) window.dispatchEvent(new CustomEvent('yumeewade:terminal-unavailable'));
    if (stored.generation !== result.generation) stored.tickets = {};
    stored.generation = result.generation; save();
  })();
  try { await ready; } catch (error) { ready = undefined; throw error; }
}
export async function discoverTerminalRecovery(): Promise<TerminalRecoveryTab[]> {
  await initializeTerminalRecovery();
  const state = stored!;
  const result = await request<TerminalRecoveryList>('/api/terminal/recovery/list', { renderer: state.renderer });
  if (state !== stored) throw new Error('Recovery scope changed');
  const ids = new Set(result.tabs.map(tab => tab.id));
  const missing = Object.keys(state.tickets).filter(id => !ids.has(id));
  for (const id of missing) delete state.tickets[id];
  if (missing.length) { save(); window.dispatchEvent(new CustomEvent('yumeewade:terminal-unavailable')); }
  return result.tabs.filter(tab => typeof state.tickets[tab.id] === 'string');
}
export async function bindTerminalRecovery(identity: { project: string; task: string; id: string; owner: string }, label: string): Promise<void> {
  await initializeTerminalRecovery();
  const state = stored!;
  const result = await request<{ ticket: string }>('/api/terminal/recovery/bind', { ...identity, renderer: state.renderer, label });
  if (state !== stored) throw new Error('Recovery scope changed');
  state.tickets[identity.id] = result.ticket; save();
}
export async function claimTerminalRecovery(tab: TerminalRecoveryTab): Promise<TerminalRecoveryLease> {
  await initializeTerminalRecovery();
  const state = stored!;
  const lease = await request<TerminalRecoveryLease>('/api/terminal/recovery/claim', { project: tab.project, task: tab.task, id: tab.id, renderer: state.renderer, ticket: state.tickets[tab.id] });
  if (state !== stored) throw new Error('Recovery scope changed');
  state.tickets[tab.id] = lease.ticket; save(); return lease;
}
export function forgetTerminalRecovery(id: string): void { if (stored) { delete stored.tickets[id]; save(); } }
export function resetTerminalRecovery(): void { stored = undefined; ready = undefined; sessionStorage.removeItem(key); }
