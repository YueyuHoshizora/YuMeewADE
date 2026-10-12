/**
 * `@path` reference syntax shared by the core (which resolves references) and the composer (which inserts them).
 * A reference may follow whitespace or an opening bracket. Prose punctuation right after it ends it instead of joining
 * the path: ASCII marks only before whitespace/end (so `a.b` and `v1.2` stay whole), CJK marks anywhere (Chinese prose
 * continues without a space: `@a.ts，然後`). `@"…"` keeps spaces and such punctuation inside the path.
 */
export const MENTION_PATTERN = /(?:^|[\s(（「『【〈《])@(?:"([^"\n]+)"|([^\s@"][^\s@]*?))(?=[,.;:!?)\]}'"]*(?:\s|$|[，。；：！？、）」』】〉》…]))/gu;

/** Whether `target` must be written as `@"target"` to be read back whole. */
export function mentionNeedsQuotes(target: string): boolean {
  return /\s|[,.;:!?)\]}'"]$|[，。；：！？、）」』】〉》…]/u.test(target);
}
