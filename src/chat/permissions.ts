import { randomUUID } from 'node:crypto';
import type { CliEvent } from '../cli/provider.ts';
import type { ToolApproval } from '../shared/types.ts';

/** Deliberately memory-only: neither pending requests nor turn grants survive restart. */
export class TurnPermissions {
  private readonly pending = new Map<string, { card: ToolApproval; respond: (allow: boolean) => void; timer: NodeJS.Timeout }>();
  private readonly allowed = new Set<string>();
  private closed = false;
  constructor(privateSeconds: number, changed: (cards: ToolApproval[]) => void) {
    this.seconds = privateSeconds;
    this.changed = changed;
  }
  private readonly seconds: number;
  private readonly changed: (cards: ToolApproval[]) => void;
  cards(): ToolApproval[] { return [...this.pending.values()].map(p => p.card); }
  request(ev: Extract<CliEvent, { type: 'permission' }>): void {
    if (this.closed || ev.tool.length > 100) { ev.respond(false); return; }
    if (this.allowed.has(ev.tool)) { ev.respond(true); return; }
    if (this.pending.size >= 16) { ev.respond(false); return; }
    const id = randomUUID();
    // Never serialize arbitrary input, credentials, file contents or environment to the DOM.
    const values = ['command', 'file_path', 'path', 'description'].map(k => ev.input[k]).filter((v): v is string => typeof v === 'string');
    const summary = values.join('\n').replace(/((?:token|password|secret|api[_-]?key|authorization)\s*(?:[=:]\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1000);
    const card = { id, tool: ev.tool.slice(0, 100), summary, expiresAt: new Date(Date.now() + this.seconds * 1000).toISOString() };
    const timer = setTimeout(() => this.answer(id, false), this.seconds * 1000);
    this.pending.set(id, { card, respond: ev.respond, timer });
    this.changed(this.cards());
  }
  answer(id: string, allow: boolean, turn = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    if (Date.now() >= Date.parse(p.card.expiresAt)) allow = false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (allow && turn) this.allowed.add(p.card.tool);
    p.respond(allow);
    this.changed(this.cards());
    if (allow && turn) for (const [other, request] of this.pending) if (request.card.tool === p.card.tool) this.answer(other, true);
    return true;
  }
  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) this.answer(id, false);
    this.allowed.clear();
  }
}
