import { el } from './dom.ts';
/** 詞法高亮只建立 text nodes，不把原始碼當成 HTML。 */
export function highlightCode(text: string, language: string): HTMLElement {
  const pre = el('pre', 'editor-highlight');
  if (language === 'plaintext') { pre.textContent = text; return pre; }
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|class|interface|type|import|export|from|return|if|else|async|await|new|true|false|null|undefined|def|self|fn|pub|struct|package|func)\b|\b\d+(?:\.\d+)?\b/g;
  let offset = 0;
  for (const token of text.matchAll(tokens)) {
    pre.append(document.createTextNode(text.slice(offset, token.index)));
    const value = token[0];
    const kind = value.startsWith('//') || value.startsWith('/*') || value.startsWith('#') ? 'comment' : /^["'`]/.test(value) ? 'string' : /^\d/.test(value) ? 'number' : 'keyword';
    const span = el('span', `syntax-${kind}`, value);
    pre.append(span); offset = token.index + value.length;
  }
  pre.append(document.createTextNode(text.slice(offset))); return pre;
}
