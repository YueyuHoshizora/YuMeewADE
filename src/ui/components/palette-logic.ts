export function rank<T extends { label: string }>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.map((item, order) => {
    const text = item.label.toLocaleLowerCase(); let position = 0; let score = 0; let previous = -1;
    for (const char of needle) {
      const found = text.indexOf(char, position);
      if (found < 0) return { item, order, score: Infinity };
      score += found === previous + 1 ? 0 : found - position + 2;
      if (previous < 0) score += found;
      previous = found; position = found + 1;
    }
    return { item, order, score: text === needle ? -2 : text.startsWith(needle) ? -1 : score };
  }).filter(entry => Number.isFinite(entry.score)).sort((a, b) => a.score - b.score || a.order - b.order).map(entry => entry.item);
}
export function routeScope(hash: string): { project: string; task: string } | undefined {
  try {
    const parts = hash.split('?')[0]!.replace(/^#/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'p' && parts[1]) return { project: parts[1], task: '' };
    if (parts[0] === 't' && parts[1] && parts[2]) return { project: parts[1], task: parts[2] };
  } catch { /* Malformed route has no actionable scope. */ }
  return undefined;
}
export function fileQuery(value: string): { path: string; line?: number } {
  const text = value.trim(); const match = /^(.*):([1-9]\d*)$/.exec(text);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return { path: text };
  return { path: match[1]!, line: Number(match[2]) };
}
