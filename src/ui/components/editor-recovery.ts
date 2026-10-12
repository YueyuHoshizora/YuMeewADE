/** Editor recovery records are kept per browser window; see mergeRecovery. */
const sameDraft = (a: unknown, b: unknown) => JSON.stringify([(a as { text?: unknown }).text, (a as { document?: { revision?: unknown } }).document?.revision]) === JSON.stringify([(b as { text?: unknown }).text, (b as { document?: { revision?: unknown } }).document?.revision]);
export const RECOVERY_BUFFER_LIMIT = 50;
type Buffer = { document?: { path?: unknown }; clean?: unknown };

function buffersOf(value: unknown): Buffer[] | undefined {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? (value as { buffers?: unknown }).buffers : undefined;
  return Array.isArray(list) ? list as Buffer[] : undefined;
}
const draftPath = (buffer: Buffer): string | undefined => buffer && typeof buffer === 'object' && buffer.clean !== true && typeof buffer.document?.path === 'string' ? buffer.document.path : undefined;

/**
 * Combines this window's record with other windows' records. Records whose heartbeat `at` is older than `liveMs`
 * (closed or crashed windows, and the record written before per-window keys) are merged in; live windows keep their own.
 * The newest stale record supplies the layout when this window has none, and stale dirty drafts are added, replacing a
 * clean entry for the same file. A record is reported as adopted only when all of its drafts were taken over, so a draft
 * that collides with one already present (or exceeds the buffer limit) is never deleted.
 * Throws when this window's own record is not valid JSON.
 */
export function mergeRecovery(own: string | null, others: { key: string; raw: string }[], now: number, liveMs: number): { raw: string | null; adopted: string[] } {
  const stale: { key: string; at: number; value: unknown }[] = [];
  for (const { key, raw } of others) {
    let value: unknown; try { value = JSON.parse(raw); } catch { continue; }
    const at = value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { at?: unknown }).at === 'number' ? (value as { at: number }).at : 0;
    if (now - at < liveMs) continue;
    // A damaged record can neither lead nor be adopted (deleted): healthy older windows still recover their drafts.
    if (!buffersOf(value)) continue;
    stale.push({ key, at, value });
  }
  if (!stale.length) return { raw: own, adopted: [] };
  stale.sort((a, b) => b.at - a.at);
  const primary: unknown = own === null ? stale[0]!.value : JSON.parse(own);
  const state = (Array.isArray(primary) ? { version: 4, buffers: primary } : primary) as { buffers?: unknown } | null;
  if (!state || typeof state !== 'object' || !Array.isArray(state.buffers)) return { raw: own, adopted: [] };
  const merged = state.buffers as Buffer[];
  const adopted = own === null ? [stale[0]!.key] : [];
  for (const record of own === null ? stale.slice(1) : stale) {
    let complete = true;
    for (const buffer of buffersOf(record.value)!) {
      const path = draftPath(buffer); if (path === undefined) continue;
      const at = merged.findIndex(item => item && typeof item === 'object' && item.document?.path === path);
      if (at >= 0 && merged[at]!.clean === true) merged[at] = buffer;
      else if (at < 0 && merged.length < RECOVERY_BUFFER_LIMIT) merged.push(buffer);
      else if (at < 0 || !sameDraft(merged[at], buffer)) complete = false;
    }
    if (complete) adopted.push(record.key);
  }
  return { raw: JSON.stringify(state), adopted };
}
