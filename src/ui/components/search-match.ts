export function searchParts(text: string, query: string): { text: string; match: boolean }[] {
  if (!query) return [{ text, match: false }];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const parts: { text: string; match: boolean }[] = [];
  let offset = 0;
  for (const hit of text.matchAll(pattern)) {
    parts.push({ text: text.slice(offset, hit.index), match: false });
    parts.push({ text: hit[0], match: true });
    offset = hit.index + hit[0].length;
  }
  parts.push({ text: text.slice(offset), match: false });
  return parts;
}
