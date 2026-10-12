export interface DiffLine {
  text: string;
  kind: 'context' | 'added' | 'removed' | 'meta' | 'hunk';
  /** 變更前／後檔案中的行號；只有內容行（context、added、removed）有。 */
  oldLine?: number;
  newLine?: number;
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

/** Path from a `diff --git` header; later `+++`/`rename to` lines override it, so it only decides binary, mode-only and empty files. */
function headerPath(rest: string): string {
  // An unquoted name may itself contain " b/". Without a rename git writes the same name twice, which pins the split (as git apply does).
  if (rest.startsWith('a/') && (rest.length - 5) % 2 === 0) {
    const name = rest.slice(2, 2 + (rest.length - 5) / 2);
    if (rest === `a/${name} b/${name}`) return name;
  }
  const paths = /^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(rest);
  return paths ? gitPath(paths[2]!).replace(/^b\//, '') : rest;
}

export function parseDiff(value: string): DiffFile[] {
  if (!value.trim()) return [];
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const raw of lines) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.startsWith('diff --git ')) {
      file = { path: headerPath(text.slice(11)), added: 0, removed: 0, lines: [] };
      files.push(file);
      inHunk = false;
    }
    if (!file) { file = { path: '', added: 0, removed: 0, lines: [] }; files.push(file); }
    let kind: DiffLine['kind'] = 'meta';
    let oldLine: number | undefined;
    let newLine: number | undefined;
    if (text.startsWith('@@')) {
      kind = 'hunk'; inHunk = true;
      const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
      oldNo = Number(start?.[1] ?? 0); newNo = Number(start?.[2] ?? 0);
    }
    else if (inHunk && text.startsWith('+')) { kind = 'added'; file.added++; newLine = newNo++; }
    else if (inHunk && text.startsWith('-')) { kind = 'removed'; file.removed++; oldLine = oldNo++; }
    else if (inHunk && text.startsWith(' ')) { kind = 'context'; oldLine = oldNo++; newLine = newNo++; }
    if (!inHunk && text.startsWith('rename to ')) file.path = gitPath(text.slice(10));
    if (!inHunk && text.startsWith('+++ ') && text.slice(4) !== '/dev/null') file.path = gitPath(text.slice(4).split('\t')[0]!).replace(/^b\//, '');
    if (!inHunk && !file.path && text.startsWith('--- ')) file.path = gitPath(text.slice(4).split('\t')[0]!).replace(/^a\//, '');
    file.lines.push({ text, kind, ...(oldLine === undefined ? {} : { oldLine }), ...(newLine === undefined ? {} : { newLine }) });
  }
  return files;
}
