// Markdown frontmatter：`---` 包起來的 YAML 子集＋正文。
// 更新時只重寫被改動的頂層鍵那幾行，保留其他行與註解（台帳可手改、可留註解）。

import { parseYamlMap, splitKey, stringifyYaml, YamlError, type YamlMap, type YamlValue } from './yaml.ts';

export interface Frontmatter {
  data: YamlMap;
  /** frontmatter 區塊內的原始行（不含兩條 `---`）。 */
  headerLines: string[];
  body: string;
}

const FENCE = '---';
// Keep the existing normalized body API (notes conflict checks depend on it), while retaining source bytes for writes.
interface SourceFormat { eol: string; body: string; rawBody: string }
const sourceFormats = new WeakMap<string[], SourceFormat>();

export function parseFrontmatter(text: string): Frontmatter {
  // A byte order mark from a Windows editor would hide the opening fence; rewrites drop it.
  text = text.replace(/^\uFEFF/, '');
  const rows = text.split(/\r?\n/);
  if (rows[0] !== FENCE) throw new YamlError('檔案必須以 --- 開頭', 1);
  const end = rows.indexOf(FENCE, 1);
  if (end < 0) throw new YamlError('frontmatter 缺少結尾 ---', rows.length);
  const headerLines = rows.slice(1, end);
  const data = parseYamlMap(headerLines.join('\n'));
  const body = rows.slice(end + 1).join('\n');
  let crlf = 0, lf = 0, line = 0, bodyStart = text.length;
  for (const match of text.matchAll(/\r?\n/g)) {
    if (match[0] === '\r\n') crlf++; else lf++;
    if (line++ === end) bodyStart = match.index + match[0].length;
  }
  const eol = crlf > lf ? '\r\n' : '\n';
  const rawBody = text.slice(bodyStart);
  sourceFormats.set(headerLines, { eol, body, rawBody });
  return { data, headerLines, body };
}

export function serializeFrontmatter(headerLines: string[], body: string): string {
  const source = sourceFormats.get(headerLines);
  const eol = source?.eol ?? '\n';
  const writtenBody = source && body === source.body ? source.rawBody : body.replace(/\r?\n/g, eol);
  return [FENCE, ...headerLines, FENCE, writtenBody].join(eol);
}

/**
 * 找出每個頂層鍵在 headerLines 中佔的行範圍 [start, end)。
 * 頂層鍵＝縮排 0、不是清單項目或註解，且 YAML 解析器能切出 `key:` 的行（引號鍵、含 `:` 的引號鍵、`-custom` 都算，
 * 鍵名依解析器解碼）；其後縮排 >0 或 `- ` 開頭的行屬於同一鍵。
 * 範圍尾端的空行與頂格 `#` 註解是獨立的（多半在說明下一個鍵），不算進前一個鍵，改寫時才不會被刪掉。
 */
function topLevelRanges(headerLines: string[]): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  let current: { key: string; start: number } | null = null;
  const close = (end: number) => {
    if (!current) return;
    while (end > current.start + 1 && /^(?:#|\s*$)/.test(headerLines[end - 1] ?? '')) end--;
    ranges.set(current.key, [current.start, end]);
  };
  for (let i = 0; i < headerLines.length; i++) {
    const line = headerLines[i] ?? '';
    if (!line || /^[\s#]/.test(line) || line === '-' || line.startsWith('- ')) continue;
    let key: string | undefined;
    try { key = splitKey(line, i + 2)?.key; } catch { key = undefined; }
    if (key !== undefined) {
      close(i);
      current = { key, start: i };
    }
  }
  close(headerLines.length);
  return ranges;
}

/** Same scalar quoting rules as the YAML subset; comment text itself is never scanned for quotes. */
function inlineComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  let previous = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === "'" && quote === "'" && raw[i + 1] === "'") i++;
      else if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && ['', ':', '-', '?', '[', '{', ','].includes(previous)) {
      quote = ch;
    } else if (ch === '#' && i > 0 && /\s/.test(raw[i - 1]!)) {
      return raw.slice(i - 1);
    }
    if (ch !== ' ' && ch !== '\t') previous = ch;
  }
  return '';
}

/** 以新值覆寫指定頂層鍵；不存在的鍵補在最後。回傳新的 headerLines。 */
export function patchHeaderLines(headerLines: string[], patch: Record<string, YamlValue>): string[] {
  const out = [...headerLines];
  const source = sourceFormats.get(headerLines);
  if (source) sourceFormats.set(out, source);
  const ranges = topLevelRanges(out);
  // 由後往前替換，避免行號位移
  const existing = Object.entries(patch)
    .filter(([k]) => ranges.has(k))
    .sort((a, b) => (ranges.get(b[0]) as [number, number])[0] - (ranges.get(a[0]) as [number, number])[0]);
  for (const [key, value] of existing) {
    const [start, end] = ranges.get(key) as [number, number];
    const old = out[start] ?? '';
    const comment = inlineComment(old);
    const fresh = stringifyYaml({ [key]: value });
    if (fresh.length === 1 && comment) fresh[0] = `${fresh[0]}${comment}`;
    out.splice(start, end - start, ...fresh);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!ranges.has(key)) out.push(...stringifyYaml({ [key]: value }));
  }
  return out;
}
