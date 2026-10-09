// YAML 子集（台帳 frontmatter、config.yaml、roles.yaml 共用）。
// 支援：純量（字串／數字／布林／null、單雙引號字串）、行內 [a, b]／{k: v}（可巢狀）、
// 縮排區塊 map 與 `- ` 清單（清單項可為純量、行內結構或 map）、`#` 註解。
// 不支援：anchor／alias、多行純量（| >）、多文件、複雜鍵。遇到就丟 YamlError。

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`YAML 第 ${line} 行：${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

interface Line {
  no: number;
  indent: number;
  text: string; // 去除縮排與註解後的內容
}

function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function toLines(text: string): Line[] {
  const out: Line[] = [];
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] ?? '';
    if (raw.includes('\t')) {
      const before = raw.slice(0, raw.length - raw.trimStart().length);
      if (before.includes('\t')) throw new YamlError('縮排不得使用 tab', i + 1);
    }
    const stripped = stripComment(raw).trimEnd();
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    out.push({ no: i + 1, indent, text: stripped.trim() });
  }
  return out;
}

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function parseScalar(text: string, lineNo: number): YamlValue {
  const t = text.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (NUMBER_RE.test(t)) return Number(t);
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new YamlError('雙引號未閉合', lineNo);
    try {
      return JSON.parse(t) as string;
    } catch {
      throw new YamlError('雙引號字串格式錯誤', lineNo);
    }
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new YamlError('單引號未閉合', lineNo);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t === '|' || t === '>' || t.startsWith('|') || t.startsWith('>')) {
    throw new YamlError('不支援多行純量（| >）', lineNo);
  }
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    throw new YamlError('不支援 anchor／alias／tag', lineNo);
  }
  return t;
}

// ---- 行內結構 [ ] { } ----

class Inline {
  private pos = 0;
  private readonly src: string;
  private readonly lineNo: number;
  constructor(src: string, lineNo: number) {
    this.src = src;
    this.lineNo = lineNo;
  }

  parse(): YamlValue {
    const v = this.value();
    this.ws();
    if (this.pos !== this.src.length) throw new YamlError('行內結構後有多餘內容', this.lineNo);
    return v;
  }

  private ws(): void {
    while (this.pos < this.src.length && (this.src[this.pos] === ' ' || this.src[this.pos] === '\t')) this.pos++;
  }

  private value(): YamlValue {
    this.ws();
    const ch = this.src[this.pos];
    if (ch === '[') return this.list();
    if (ch === '{') return this.map();
    if (ch === '"' || ch === "'") return this.quoted();
    return parseScalar(this.plain(), this.lineNo);
  }

  private quoted(): string {
    const q = this.src[this.pos] as string;
    let i = this.pos + 1;
    for (; i < this.src.length; i++) {
      const c = this.src[i];
      if (q === '"' && c === '\\') i++;
      else if (c === q) {
        if (q === "'" && this.src[i + 1] === "'") {
          i++;
          continue;
        }
        break;
      }
    }
    if (i >= this.src.length) throw new YamlError('引號未閉合', this.lineNo);
    const text = this.src.slice(this.pos, i + 1);
    this.pos = i + 1;
    return parseScalar(text, this.lineNo) as string;
  }

  private plain(): string {
    const start = this.pos;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ',' || c === ']' || c === '}') break;
      this.pos++;
    }
    return this.src.slice(start, this.pos).trim();
  }

  private list(): YamlValue[] {
    this.pos++; // [
    const out: YamlValue[] = [];
    this.ws();
    if (this.src[this.pos] === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.src[this.pos];
      if (c === ',') {
        this.pos++;
        this.ws();
        if (this.src[this.pos] === ']') {
          this.pos++;
          return out;
        }
        continue;
      }
      if (c === ']') {
        this.pos++;
        return out;
      }
      throw new YamlError('行內清單缺少 , 或 ]', this.lineNo);
    }
  }

  private map(): YamlMap {
    this.pos++; // {
    const out: YamlMap = {};
    this.ws();
    if (this.src[this.pos] === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      let key: string;
      if (this.src[this.pos] === '"' || this.src[this.pos] === "'") {
        key = this.quoted();
      } else {
        const start = this.pos;
        while (this.pos < this.src.length && this.src[this.pos] !== ':' && this.src[this.pos] !== ',' && this.src[this.pos] !== '}') this.pos++;
        key = this.src.slice(start, this.pos).trim();
      }
      this.ws();
      if (this.src[this.pos] !== ':') throw new YamlError('行內 map 缺少 :', this.lineNo);
      this.pos++;
      out[key] = this.value();
      this.ws();
      const c = this.src[this.pos];
      if (c === ',') {
        this.pos++;
        this.ws();
        if (this.src[this.pos] === '}') {
          this.pos++;
          return out;
        }
        continue;
      }
      if (c === '}') {
        this.pos++;
        return out;
      }
      throw new YamlError('行內 map 缺少 , 或 }', this.lineNo);
    }
  }
}

function parseValueText(text: string, lineNo: number): YamlValue {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) return new Inline(t, lineNo).parse();
  return parseScalar(t, lineNo);
}

// ---- 區塊結構 ----

/** 找出 `key: value` 的冒號位置（引號內與 URL 的 `://` 不算）。 */
function splitKey(text: string, lineNo: number): { key: string; rest: string } | null {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) {
      quote = c;
      continue;
    }
    if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) {
      const rawKey = text.slice(0, i).trim();
      const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? (parseScalar(rawKey, lineNo) as string) : rawKey;
      if (key === '') throw new YamlError('鍵不得為空', lineNo);
      return { key, rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

class Block {
  private i = 0;
  private readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  parseDocument(): YamlValue {
    if (this.lines.length === 0) return {};
    const first = this.lines[0] as Line;
    const v = this.node(first.indent);
    if (this.i < this.lines.length) {
      throw new YamlError('縮排不一致', (this.lines[this.i] as Line).no);
    }
    return v;
  }

  private peek(): Line | undefined {
    return this.lines[this.i];
  }

  private node(indent: number): YamlValue {
    const line = this.peek();
    if (!line) return null;
    if (line.text === '-' || line.text.startsWith('- ')) return this.list(indent);
    return this.map(indent);
  }

  private list(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) break;
      const body = line.text === '-' ? '' : line.text.slice(2).trim();
      if (body === '') {
        this.i++;
        const next = this.peek();
        if (next && next.indent > indent) out.push(this.node(next.indent));
        else out.push(null);
        continue;
      }
      // `- key: value` 開頭的 map：把這行視為縮排 indent+2 的 map 第一行
      const kv = splitKey(body, line.no);
      if (kv && !body.startsWith('[') && !body.startsWith('{') && !body.startsWith('"') && !body.startsWith("'")) {
        const childIndent = indent + 2;
        this.lines[this.i] = { no: line.no, indent: childIndent, text: body };
        out.push(this.map(childIndent));
        continue;
      }
      this.i++;
      out.push(parseValueText(body, line.no));
    }
    return out;
  }

  private map(indent: number): YamlMap {
    const out: YamlMap = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent) {
        if (line && line.indent > indent) throw new YamlError('縮排不一致', line.no);
        break;
      }
      if (line.text === '-' || line.text.startsWith('- ')) break;
      const kv = splitKey(line.text, line.no);
      if (!kv) throw new YamlError('不是 key: value 格式', line.no);
      if (Object.hasOwn(out, kv.key)) throw new YamlError(`重複的鍵 ${kv.key}`, line.no);
      this.i++;
      if (kv.rest === '') {
        const next = this.peek();
        if (next && next.indent > indent) {
          out[kv.key] = this.node(next.indent);
        } else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
          out[kv.key] = this.list(indent);
        } else {
          out[kv.key] = null;
        }
      } else {
        out[kv.key] = parseValueText(kv.rest, line.no);
      }
    }
    return out;
  }
}

export function parseYaml(text: string): YamlValue {
  return new Block(toLines(text)).parseDocument();
}

/** 解析並要求頂層為 map（台帳與設定檔皆然）。 */
export function parseYamlMap(text: string): YamlMap {
  const v = parseYaml(text);
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new YamlError('頂層必須是 key: value 結構', 1);
  return v;
}

// ---- 序列化 ----

const PLAIN_SAFE_RE = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^#]*$/u;

export function yamlScalar(v: string | number | boolean | null): string {
  if (v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === '') return '""';
  const special = v === 'true' || v === 'false' || v === 'null' || v === '~' || NUMBER_RE.test(v);
  if (!special && PLAIN_SAFE_RE.test(v) && !v.includes(': ') && !v.endsWith(':') && v.trim() === v && !/[\r\n]/.test(v)) {
    return v;
  }
  return JSON.stringify(v);
}

function isScalar(v: YamlValue): v is string | number | boolean | null {
  return v === null || typeof v !== 'object';
}

// 行內分隔符與引號不能沿用區塊純量的安全判斷；map 的 key 也以冒號分隔。
function flowScalar(v: string | number | boolean | null): string {
  return typeof v === 'string' && /[,[\]{}:'"]/.test(v) ? JSON.stringify(v) : yamlScalar(v);
}

function inline(v: YamlValue): string {
  if (isScalar(v)) return flowScalar(v);
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  const parts = Object.entries(v).map(([k, val]) => `${flowScalar(k)}: ${inline(val)}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * 以區塊形式輸出一個 map；純量陣列與純量 map 的陣列用行內寫法，巢狀 map 用縮排。
 * 回傳的每行不含結尾換行。
 */
export function stringifyYaml(value: YamlMap, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    const k = yamlScalar(key);
    if (isScalar(v)) {
      lines.push(`${pad}${k}:${v === null ? '' : ' ' + yamlScalar(v)}`);
    } else if (Array.isArray(v)) {
      if (v.every((x) => isScalar(x) || (x !== null && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every(isScalar)))) {
        lines.push(`${pad}${k}: ${inline(v)}`);
      } else {
        lines.push(`${pad}${k}:`);
        for (const item of v) {
          if (isScalar(item) || Array.isArray(item)) lines.push(`${pad}  - ${inline(item)}`);
          else {
            const sub = stringifyYaml(item, indent + 4);
            lines.push(`${pad}  - ${(sub[0] ?? '').trimStart()}`, ...sub.slice(1));
          }
        }
      }
    } else {
      if (Object.keys(v).length === 0) lines.push(`${pad}${k}: {}`);
      else lines.push(`${pad}${k}:`, ...stringifyYaml(v, indent + 2));
    }
  }
  return lines;
}
