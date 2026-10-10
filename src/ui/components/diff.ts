export interface DiffLine {
  text: string;
  kind: 'context' | 'added' | 'removed' | 'meta' | 'hunk';
}
export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

// Git quotes unusual paths using C escapes; decoding also preserves non-ASCII UTF-8 names.
function gitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07' };
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== '\\') {
      const point = value.codePointAt(i)!;
      bytes.push(...encoder.encode(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; }
    else { i++; bytes.push(...encoder.encode(escapes[value[i]!] ?? value[i]!)); }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function parseDiff(value: string): DiffFile[] {
  if (!value.trim()) return [];
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let inHunk = false;
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const raw of lines) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.startsWith('diff --git ')) {
      const paths = /^diff --git ("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(text);
      file = { path: paths ? gitPath(paths[2]!).replace(/^b\//, '') : text.slice(11), added: 0, removed: 0, lines: [] };
      files.push(file);
      inHunk = false;
    }
    if (!file) { file = { path: '', added: 0, removed: 0, lines: [] }; files.push(file); }
    let kind: DiffLine['kind'] = 'meta';
    if (text.startsWith('@@')) { kind = 'hunk'; inHunk = true; }
    else if (inHunk && text.startsWith('+')) { kind = 'added'; file.added++; }
    else if (inHunk && text.startsWith('-')) { kind = 'removed'; file.removed++; }
    else if (inHunk && text.startsWith(' ')) kind = 'context';
    if (!inHunk && text.startsWith('rename to ')) file.path = gitPath(text.slice(10));
    if (!inHunk && text.startsWith('+++ ') && text.slice(4) !== '/dev/null') file.path = gitPath(text.slice(4).split('\t')[0]!).replace(/^b\//, '');
    if (!inHunk && !file.path && text.startsWith('--- ')) file.path = gitPath(text.slice(4).split('\t')[0]!).replace(/^a\//, '');
    file.lines.push({ text, kind });
  }
  return files;
}
