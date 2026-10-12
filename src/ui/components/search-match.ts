/**
 * Highlights what the conversation search (src/chat/search.ts) matched: the query and each character of the text are
 * lowercased on their own, so a character whose lowercase form is longer (`İ` → `i̇`) still highlights as a whole.
 */
export function searchParts(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.normalize('NFC').toLocaleLowerCase();
  if (!needle) return [{ text, match: false }];
  // Lowered text, and for every character boundary its offset in the lowered and in the original text.
  let lower = ''; const lowered: number[] = []; const original: number[] = []; let at = 0;
  for (const character of text) { lowered.push(lower.length); original.push(at); lower += character.toLocaleLowerCase(); at += character.length; }
  lowered.push(lower.length); original.push(at);
  // Original offset of the last character boundary at or before a lowered offset (a match start) or the first at or after it (an end).
  const floor = (offset: number): number => { let low = 0, high = lowered.length - 1; while (low < high) { const mid = (low + high + 1) >> 1; if (lowered[mid]! <= offset) low = mid; else high = mid - 1; } return original[low]!; };
  const ceil = (offset: number): number => { let low = 0, high = lowered.length - 1; while (low < high) { const mid = (low + high) >> 1; if (lowered[mid]! >= offset) high = mid; else low = mid + 1; } return original[low]!; };
  const parts: { text: string; match: boolean }[] = [];
  let offset = 0;
  for (let from = 0, hit = lower.indexOf(needle); hit >= 0; hit = lower.indexOf(needle, from)) {
    const start = floor(hit); const end = ceil(hit + needle.length);
    from = hit + needle.length;
    if (start < offset) continue;
    parts.push({ text: text.slice(offset, start), match: false }, { text: text.slice(start, end), match: true });
    offset = end;
  }
  parts.push({ text: text.slice(offset), match: false });
  return parts;
}
