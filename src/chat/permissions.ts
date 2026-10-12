import { randomUUID } from 'node:crypto';
import type { CliEvent } from '../cli/provider.ts';
import type { ToolApproval } from '../shared/types.ts';

// What the action does comes first; `description` is the AI's own wording about it and is shown last.
const FIELD_ORDER = ['command', 'cwd', 'url', 'file_path', 'notebook_path', 'path', 'files', 'pattern', 'old_string', 'new_string', 'content', 'new_source', 'diff'];
const SECRET_KEY = /token|password|passwd|secret|api[_-]?key|authorization|cookie|credential/i;
const FIELD_LIMIT = 8000;
const CARD_LIMIT = 20_000;

// Well-known credential shapes that appear without a label, e.g. `git push https://ghp_…@github.com` or an env assignment
// the AI inlined. Prefixes plus a minimum length, so short words like `sk-video` stay readable for the review.
const KNOWN_TOKEN = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

function redact(text: string): string {
  // URL credentials first, so `https://x-access-token:…@host` keeps its host instead of matching the `token:` label rule.
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:[^\s/?#@]+@/gi, '$1[redacted]@')
    .replace(/((?:token|password|secret|api[_-]?key|authorization)\s*(?:[=:]\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(KNOWN_TOKEN, '[redacted]');
}

/**
 * Allow approves the whole input, so the card shows every field (secrets redacted), not a chosen few: a WebFetch URL,
 * the text a Write puts on disk or an MCP argument must be visible. Anything cut to fit is flagged instead of hidden.
 */
export function approvalSummary(input: Record<string, unknown>): { summary: string; truncated: boolean } {
  const rank = (key: string) => key === 'description' ? FIELD_ORDER.length + 1 : FIELD_ORDER.includes(key) ? FIELD_ORDER.indexOf(key) : FIELD_ORDER.length;
  let truncated = false;
  const lines: string[] = [];
  for (const key of Object.keys(input).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    let value = SECRET_KEY.test(key) ? '[redacted]' : redact(typeof raw === 'string' ? raw : JSON.stringify(raw, (name, item: unknown) => name && SECRET_KEY.test(name) ? '[redacted]' : item) ?? String(raw));
    if (value.length > FIELD_LIMIT) { value = value.slice(0, FIELD_LIMIT); truncated = true; }
    lines.push(`${key.slice(0, 100)}: ${value}`);
  }
  let summary = lines.join('\n');
  if (summary.length > CARD_LIMIT) { summary = summary.slice(0, CARD_LIMIT); truncated = true; }
  return { summary, truncated };
}

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
    const { summary, truncated } = approvalSummary(ev.input);
    const card = { id, tool: ev.tool.slice(0, 100), summary, ...(truncated ? { truncated } : {}), expiresAt: new Date(Date.now() + this.seconds * 1000).toISOString() };
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
