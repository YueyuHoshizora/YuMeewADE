import { t } from '../i18n/index.ts';
import { el, iconButton, input } from './dom.ts';

const MAX_MATCHES = 2000;
let bar: HTMLElement | undefined;

/** Case-insensitive matches inside single text nodes of `root`, skipping the find bar itself and hidden content. */
function matches(root: Element, query: string, exclude: Element): Range[] {
  const needle = query.toLocaleLowerCase(); const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => {
    const parent = node.parentElement;
    return !parent || exclude.contains(parent) || parent.closest('script,style,template') || !parent.checkVisibility() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  } });
  for (let node = walker.nextNode(); node && ranges.length < MAX_MATCHES; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLocaleLowerCase();
    for (let at = text.indexOf(needle); at >= 0 && ranges.length < MAX_MATCHES; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + needle.length); ranges.push(range);
    }
  }
  return ranges;
}

/** Finds visible text in the current page (chat, terminal, diffs) for the desktop app, which has no browser find bar. CodeMirror keeps its own search panel. */
export function openFindBar(): void {
  const existing = bar?.querySelector('input');
  if (bar?.isConnected && existing) { existing.focus(); existing.select(); return; }
  const field = input('', t('find.label')); field.type = 'search'; field.setAttribute('aria-label', t('find.label'));
  const status = el('span', 'muted'); status.setAttribute('role', 'status');
  let index = -1;
  const clear = (): void => { CSS.highlights.delete('find-match'); CSS.highlights.delete('find-current'); };
  // Re-scan on every step: chat and terminal output keep changing while the bar is open.
  const go = (step: number): void => {
    clear();
    if (!field.value) { status.textContent = ''; index = -1; return; }
    const ranges = matches(node.parentElement ?? document.body, field.value, node);
    if (!ranges.length) { status.textContent = t('find.none'); index = -1; return; }
    index = index < 0 ? 0 : (index + step + ranges.length) % ranges.length;
    const current = ranges[index]!;
    CSS.highlights.set('find-match', new Highlight(...ranges));
    CSS.highlights.set('find-current', new Highlight(current));
    current.startContainer.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    status.textContent = `${index + 1}/${ranges.length}${ranges.length === MAX_MATCHES ? '+' : ''}`;
  };
  const close = (): void => { clear(); node.remove(); if (bar === node) bar = undefined; };
  const node = el('div', 'find-bar'); node.setAttribute('role', 'search');
  node.append(field, iconButton('↑', t('find.previous'), () => { go(-1); field.focus(); }), iconButton('↓', t('find.next'), () => { go(1); field.focus(); }), status, iconButton('×', t('common.close'), close));
  field.addEventListener('input', () => { index = -1; go(0); });
  field.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  // An open modal makes the rest of the page inert, so the bar lives in (and searches) the topmost dialog.
  ([...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body).append(node);
  bar = node; field.focus();
}
