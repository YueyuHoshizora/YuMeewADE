import { request } from '../api.ts';
import { el, button } from './dom.ts';
import { t } from '../i18n/index.ts';

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
  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|https?:\/\/[^\s<>]+|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+|(?:\/[\w.@+-]+){2,}(?:\/[\w.@+-]*)?)/g;
  let offset = 0;
  for (const hit of value.matchAll(pattern)) {
    const token = hit[0]; const index = hit.index;
    parent.append(document.createTextNode(value.slice(offset, index))); offset = index + token.length;
    if (token.startsWith('`')) {
      const path = token.slice(1, -1);
      if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) parent.append(button(path, () => request('/api/open', { path }), 'path inline-code'));
      else parent.append(el('code', '', path));
    } else if (token.startsWith('**')) parent.append(el('strong', '', token.slice(2, -2)));
    else if (token.startsWith('/') || /^[A-Za-z]:[\\/]/.test(token)) parent.append(button(token, () => request('/api/open', { path: token }), 'path'));
    else {
      const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token); const url = match?.[2] ?? token; const label = match?.[1] ?? token;
      if (/^https?:\/\//i.test(url)) { const a = el('a', '', label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
      else if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url)) parent.append(button(label, () => request('/api/open', { path: url }), 'path'));
      else parent.append(document.createTextNode(token));
    }
  }
  parent.append(document.createTextNode(value.slice(offset)));
}
export function markdown(value: string): HTMLElement {
  const node = el('div', 'markdown'); const lines = value.replace(/\r/g, '').split('\n'); let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(); const code: string[] = []; i++;
      while (i < lines.length && !lines[i]?.startsWith('```')) code.push(lines[i++] ?? '');
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
      const block = el('div', 'code-block'); const bar = el('div', 'code-toolbar'); bar.append(el('span', 'muted', language), copy); block.append(bar, pre); node.append(block); i++; continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const h = el(`h${Math.min(6, heading[1]!.length)}` as 'h1'); inline(h, heading[2]!); node.append(h); i++; continue; }
    const cells = (s: string): string[] => s.trim().replace(/^\||(?<!\\)\|$/g, '').split(/(?<!\\)\|/).map(v => v.trim().replace(/\\\|/g, '|'));
    const separators = cells(lines[i + 1] ?? ''); const headers = cells(line);
    if (line.includes('|') && separators.length === headers.length && separators.every(s => /^:?-{3,}:?$/.test(s))) {
      const table = el('table'); const head = el('thead'); const body = el('tbody'); const tr = el('tr');
      const align = separators.map(s => s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : 'left');
      for (const [at, cell] of headers.entries()) { const th = el('th'); th.style.textAlign = align[at]!; inline(th, cell); tr.append(th); } head.append(tr); i += 2;
      while (i < lines.length && lines[i]?.includes('|')) { const r = el('tr'); const values = cells(lines[i++]!); for (const [at] of headers.entries()) { const td = el('td'); td.style.textAlign = align[at]!; inline(td, values[at] ?? ''); r.append(td); } body.append(r); }
      table.append(head, body); const wrap = el('div', 'table-scroll'); wrap.append(table); node.append(wrap); continue;
    }
    if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line); const list = el(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*(?:[-*+] |\d+\. )/.test(lines[i] ?? '')) { const li = el('li'); inline(li, lines[i++]!.replace(/^\s*(?:[-*+] |\d+\. )/, '')); list.append(li); } node.append(list); continue;
    }
    const paragraph = el('p'); inline(paragraph, line); node.append(paragraph); i++;
  }
  return node;
}
