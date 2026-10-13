import { request } from '../api.ts';
import { el, button } from './dom.ts';
import { t } from '../i18n/index.ts';
import { closingFence, listMarker, openingFence, type Fence } from './markdown-stream.ts';

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const previous = document.activeElement;
    const fallback = el('textarea', 'visually-hidden');
    fallback.value = text;
    fallback.readOnly = true;
    document.body.append(fallback);
    fallback.select();
    try {
      if (!document.execCommand('copy')) throw new Error('copy');
    } finally {
      fallback.remove();
      if (previous instanceof HTMLElement) previous.focus();
    }
  }
}

// 不使用 HTML parser：AI 回覆也視為不可信任的文字，網址只接受 HTTP(S)。
function inline(parent: HTMLElement, value: string): void {
  const pattern = /(`[^`]+`|\[[^\]]+\]\(|\*\*[^*]+\*\*|https?:\/\/[^\s<>]+|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+|(?:\/[\w.@+-]+){2,}(?:\/[\w.@+-]*)?)/g;
  let offset = 0;
  for (let hit = pattern.exec(value); hit; hit = pattern.exec(value)) {
    let token = hit[0]; const index = hit.index;
    if (token.startsWith('[')) {
      let depth = 1; let end = pattern.lastIndex;
      for (; end < value.length; end++) {
        if (value[end] === '\\' && end + 1 < value.length) { end++; continue; }
        if (value[end] === '(') depth++;
        if (value[end] === ')' && --depth === 0) break;
      }
      if (depth !== 0) continue;
      token = value.slice(index, end + 1);
      pattern.lastIndex = end + 1;
    }
    parent.append(document.createTextNode(value.slice(offset, index))); offset = index + token.length;
    if (token.startsWith('`')) {
      const path = token.slice(1, -1);
      if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) parent.append(button(path, () => request('/api/open', { path }), 'path inline-code'));
      else parent.append(el('code', '', path));
    } else if (token.startsWith('**')) parent.append(el('strong', '', token.slice(2, -2)));
    else if (token.startsWith('/') || /^[A-Za-z]:[\\/]/.test(token)) parent.append(button(token, () => request('/api/open', { path: token }), 'path'));
    else {
      const match = /^\[([^\]]+)\]\(([\s\S]*)\)$/.exec(token); const url = match ? match[2]!.replace(/\\([\\()])/g, '$1') : token; const label = match?.[1] ?? token;
      if (/^https?:\/\//i.test(url)) {
        const a = el('a', '', label); a.href = url; a.title = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a);
        // The AI chooses the link text; when it is not the URL itself, show where the link really goes (the desktop app has no status bar).
        const host = URL.canParse(url) ? new URL(url).host : '';
        if (label !== url && label !== host && host) parent.append(el('span', 'link-host', ` (${host})`));
      }
      else if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) parent.append(button(label, () => request('/api/open', { path: url }), 'path'));
      else parent.append(document.createTextNode(token));
    }
  }
  parent.append(document.createTextNode(value.slice(offset)));
}
export function markdown(value: string): HTMLElement {
  const node = el('div', 'markdown'); const lines = value.replace(/\r/g, '').split('\n'); let i = 0;
  const renderFence = (parent: HTMLElement, fence: Fence): void => {
      const language = fence.language; const code: string[] = []; i++;
      while (i < lines.length && !closingFence(lines[i]!, fence)) {
        const line = lines[i++]!;
        let indent = 0;
        while (indent < fence.indent && line[indent] === ' ') indent++;
        code.push(line.slice(indent));
      }
      const text = code.join('\n'); const pre = el('pre'); pre.append(el('code', '', text));
      const copy = button(t('markdown.copy'), async () => {
        try {
          await copyText(text);
          copy.textContent = t('markdown.copied');
        } catch {
          copy.textContent = t('markdown.copyFailed');
        }
        window.setTimeout(() => { copy.textContent = t('markdown.copy'); }, 1500);
      });
      const block = el('div', 'code-block'); const bar = el('div', 'code-toolbar'); bar.append(el('span', 'muted', language), copy); block.append(bar, pre); parent.append(block);
      if (i < lines.length) i++;
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = openingFence(line);
    if (fence) { renderFence(node, fence); continue; }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const h = el(`h${Math.min(6, heading[1]!.length)}` as 'h1'); inline(h, heading[2]!); node.append(h); i++; continue; }
    const cells = (s: string): string[] => s.trim().replace(/^\||(?<!\\)\|$/g, '').split(/(?<!\\)\|/).map(v => v.trim().replace(/\\\|/g, '|'));
    const separators = cells(lines[i + 1] ?? ''); const headers = cells(line);
    if (line.includes('|') && separators.length === headers.length && separators.every(s => /^:?-{3,}:?$/.test(s))) {
      const table = el('table'); const head = el('thead'); const body = el('tbody'); const tr = el('tr');
      const align = separators.map(s => s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : 'left');
      for (const [at, cell] of headers.entries()) { const th = el('th'); th.style.textAlign = align[at]!; inline(th, cell); tr.append(th); } head.append(tr); i += 2;
      // A fence line starts a code block even when it contains `|` (as in GFM); the streaming splitter counts it as a fence too.
      while (i < lines.length && lines[i]?.includes('|') && !openingFence(lines[i]!)) { const r = el('tr'); const values = cells(lines[i++]!); for (const [at] of headers.entries()) { const td = el('td'); td.style.textAlign = align[at]!; inline(td, values[at] ?? ''); r.append(td); } body.append(r); }
      table.append(head, body); const wrap = el('div', 'table-scroll'); wrap.append(table); node.append(wrap); continue;
    }
    if (listMarker(line)) {
      const stack: { list: HTMLElement; item: HTMLElement; indent: number; column: number; ordered: boolean }[] = [];
      while (i < lines.length) {
        const marker = listMarker(lines[i]!);
        if (!marker) {
          const parent = stack.at(-1);
          const continuation = parent && openingFence(lines[i]!, parent.column + 3);
          if (parent && continuation && continuation.indent >= parent.column) { renderFence(parent.item, continuation); continue; }
          break;
        }
        while (stack.length && marker.indent < stack.at(-1)!.column && marker.indent !== stack.at(-1)!.indent) stack.pop();
        let current = stack.at(-1);
        if (current && marker.indent === current.indent && marker.ordered !== current.ordered) {
          stack.pop(); current = stack.at(-1);
        }
        if (!current || (marker.indent >= current.column && stack.length < 8)) {
          const list = el(marker.ordered ? 'ol' : 'ul');
          if (marker.ordered) (list as HTMLOListElement).start = marker.start;
          (current?.item ?? node).append(list);
          current = { list, item: el('li'), indent: marker.indent, column: marker.column, ordered: marker.ordered };
          stack.push(current);
        }
        const item = el('li'); inline(item, marker.text); current.list.append(item);
        current.item = item; current.column = marker.column; i++;
      }
      continue;
    }
    const paragraph = el('p'); inline(paragraph, line); node.append(paragraph); i++;
  }
  return node;
}
