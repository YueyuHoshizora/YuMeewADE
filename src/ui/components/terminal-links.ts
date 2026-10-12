export type TerminalLink = { kind: 'url'; url: string } | { kind: 'file'; path: string; line?: number };

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
// `src/a.ts:12:5`, `/abs/a.ts:3`, `./a.ts(12,5)` (tsc). The extension must start with a letter so versions like `1.2.3` never match.
const FILE_PATTERN = /(?<![\w./@~+-])((?:\.{0,2}\/)?(?:[\w@~+-][\w.@~+-]*\/)*[\w@~+-][\w.@~+-]*\.([A-Za-z]\w*))(?::(\d+)(?::\d+)?|\((\d+),\d+\))?/g;

/** Drops trailing sentence punctuation and unmatched closing brackets that terminals print after URLs. */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1]!;
    if ('.,;:!?\'"'.includes(last)) { end--; continue; }
    const open = { ')': '(', ']': '[', '}': '{' }[last];
    if (open && url.slice(0, end).split(open).length <= url.slice(0, end).split(last).length - 1) { end--; continue; }
    return url.slice(0, end);
  }
}

/** The URL or file reference covering `column` (a UTF-16 offset; the end boundary counts because carets land between characters). */
export function terminalLinkAt(text: string, column: number): TerminalLink | undefined {
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (column >= match.index && column <= match.index + url.length) return { kind: 'url', url };
    if (column >= match.index && column <= match.index + match[0].length) return undefined;
  }
  for (const match of text.matchAll(FILE_PATTERN)) {
    if (column < match.index || column > match.index + match[0].length) continue;
    const [, path, extension, colonLine, parenLine] = match;
    const line = Number(colonLine ?? parenLine);
    // A bare `e.g` or `a.b` is too likely to be prose; demand a directory, a line number or a real extension.
    if (!path!.includes('/') && !colonLine && !parenLine && extension!.length < 2) return undefined;
    return { kind: 'file', path: path!, ...(Number.isSafeInteger(line) && line >= 1 ? { line } : {}) };
  }
  return undefined;
}

/** Maps a printed path to one relative to the terminal's root, or undefined when it points outside it. */
export function terminalFilePath(printed: string, root: string): string | undefined {
  let relative = printed;
  if (printed.startsWith('/')) {
    const base = root.replace(/\/+$/, '');
    if (!base || !printed.startsWith(`${base}/`)) return undefined;
    relative = printed.slice(base.length + 1);
  }
  relative = relative.replace(/^(\.\/)+/, '');
  const parts = relative.split('/');
  return relative && parts.every(part => part && part !== '.' && part !== '..') ? relative : undefined;
}
