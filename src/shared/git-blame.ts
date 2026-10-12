// git blame --line-porcelain 解析：純函式，核心解析後以結構化資料回傳 UI。

export interface BlameLine {
  /** Final line number in the working file, 1-based. */
  line: number;
  sha: string;
  /** False for lines that only exist in the working tree (git reports an all-zero sha). */
  committed: boolean;
  author: string;
  /** Author time as ISO-8601, empty when git omitted it. */
  time: string;
  summary: string;
  text: string;
}

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/u;

/** Parses `git blame --line-porcelain`, which repeats every commit header before each content line. */
export function parseBlame(porcelain: string): BlameLine[] {
  const lines: BlameLine[] = [];
  let current: BlameLine | undefined;
  for (const row of porcelain.split('\n')) {
    if (current && row.startsWith('\t')) { current.text = row.slice(1); lines.push(current); current = undefined; continue; }
    const header = HEADER.exec(row);
    if (header) { current = { line: Number(header[2]), sha: header[1]!, committed: !/^0+$/u.test(header[1]!), author: '', time: '', summary: '', text: '' }; continue; }
    if (!current) continue;
    const space = row.indexOf(' ');
    const key = space < 0 ? row : row.slice(0, space); const value = space < 0 ? '' : row.slice(space + 1);
    if (key === 'author') current.author = value;
    else if (key === 'author-time' && /^\d+$/u.test(value)) current.time = new Date(Number(value) * 1000).toISOString();
    else if (key === 'summary') current.summary = value;
  }
  return lines;
}
