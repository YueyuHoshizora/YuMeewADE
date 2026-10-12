// 快速開檔排序：純函式，路由與測試共用。

/**
 * Ranks workspace-relative paths for quick open, case-insensitively:
 * basename prefix, basename substring, path substring, an in-order subsequence inside the basename
 * (e.g. `fts` → `files.ts`), then one spanning directories. Tighter spans rank higher; misses are dropped.
 */
export function rankFiles(files: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  const scored: { file: string; tier: number; span: number }[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let tier: number; let span = 0;
    if (base.startsWith(needle)) tier = 0;
    else if (base.includes(needle)) tier = 1;
    else if (lower.includes(needle)) tier = 2;
    else {
      span = subsequenceSpan(base, needle);
      if (span >= 0) tier = 3;
      else {
        span = subsequenceSpan(lower, needle);
        if (span < 0) continue;
        tier = 4;
      }
    }
    scored.push({ file, tier, span });
  }
  scored.sort((a, b) => a.tier - b.tier || a.span - b.span || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.map(entry => entry.file);
}

/** Length of the shortest window of `text` containing `needle` as a subsequence, or -1. */
function subsequenceSpan(text: string, needle: string): number {
  let best = -1;
  for (let start = text.indexOf(needle[0]!); start !== -1; start = text.indexOf(needle[0]!, start + 1)) {
    let at = start;
    for (let index = 1; index < needle.length && at !== -1; index++) at = text.indexOf(needle[index]!, at + 1);
    if (at === -1) break; // later starts cannot complete either
    const span = at - start + 1;
    if (best < 0 || span < best) best = span;
  }
  return best;
}
