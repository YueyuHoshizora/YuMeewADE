/** 輸入框的 `@檔名` 提及：判斷游標前的 @token、套用選擇、並管理候選清單。 */
import { mentionReference } from '../../shared/mention-syntax.ts';
export interface Mention {
  /** `@` 所在的位置。 */
  start: number;
  query: string;
}

/** `@` 必須在字首、空白或左括號之後（與核心解析相同），token 不含空白。 */
export function mentionAt(text: string, caret: number): Mention | null {
  const found = /(?:^|[\s(（「『【〈《])@([^\s@]*)$/u.exec(text.slice(0, caret));
  return found ? { start: caret - found[1]!.length - 1, query: found[1]! } : null;
}

/** Where the reference that starts at `mention.start` ends: through its closing quote, or up to the next whitespace. */
function mentionEnd(text: string, mention: Mention, caret: number): number {
  if (text[mention.start + 1] === '"') {
    for (let at = mention.start + 2; at < text.length && text[at] !== '\n'; at++) {
      if (text[at] === '\\' && text[at + 1] === '"') { at++; continue; }
      if (text[at] === '"') return Math.max(caret, at + 1);
    }
    return caret;
  }
  const rest = /^[^\s]*/u.exec(text.slice(caret))![0];
  return caret + rest.length;
}

/** Replaces the whole reference token the caret is in (not just its part before the caret); following prose stays. */
export function applyMention(text: string, mention: Mention, caret: number, file: string): { text: string; caret: number } {
  const insert = `${mentionReference(file)} `;
  const end = mentionEnd(text, mention, caret);
  const after = text.slice(end);
  // The inserted reference ends with a space; do not double the one that already follows the old token.
  return { text: text.slice(0, mention.start) + insert + (after.startsWith(' ') ? after.slice(1) : after), caret: mention.start + insert.length };
}

/** Scope the editor/palette insertion contract to the currently mounted composer. */
export function attachComposeInsert(input: HTMLTextAreaElement, project: string, task: string, target: EventTarget = window): () => void {
  const insert = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object') return;
    const value = detail as Record<string, unknown>;
    if (value.project !== project || value.task !== task || typeof value.text !== 'string') return;
    input.setRangeText(value.text, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  target.addEventListener('yumeewade:compose-insert', insert);
  return () => target.removeEventListener('yumeewade:compose-insert', insert);
}

export function attachMention(input: HTMLTextAreaElement, load: (query: string) => Promise<string[]>): HTMLUListElement {
  const list = document.createElement('ul');
  list.className = 'mention-list';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  let items: string[] = [];
  let index = 0;
  let current: Mention | null = null;
  let serial = 0;
  let timer: number | undefined;
  const close = () => { serial++; window.clearTimeout(timer); list.hidden = true; items = []; current = null; };
  const render = () => {
    list.replaceChildren(...items.map((file, i) => {
      const item = document.createElement('li');
      item.textContent = file;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === index));
      item.classList.toggle('active', i === index);
      item.onmousedown = event => { event.preventDefault(); choose(i); };
      return item;
    }));
    list.hidden = items.length === 0;
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  function choose(i: number): void {
    const file = items[i];
    // The caret may have left the token without an input or click event (arrow keys, Home/End): never apply a stale range.
    const caret = input.selectionStart ?? 0; const live = input.selectionStart === input.selectionEnd ? mentionAt(input.value, caret) : null;
    if (!current || file === undefined || !live || live.start !== current.start) { close(); return; }
    const applied = applyMention(input.value, live, caret, file);
    input.value = applied.text;
    input.setSelectionRange(applied.caret, applied.caret);
    close();
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
  const refresh = () => {
    const mention = mentionAt(input.value, input.selectionStart ?? 0);
    if (!mention) { close(); return; }
    current = mention;
    window.clearTimeout(timer);
    const mine = ++serial;
    timer = window.setTimeout(() => {
      void load(mention.query).then(found => {
        if (mine !== serial) return;
        items = found;
        index = 0;
        render();
      }, () => { if (mine === serial) close(); });
    }, 120);
  };
  input.addEventListener('input', refresh);
  input.addEventListener('click', refresh);
  input.addEventListener('blur', () => window.setTimeout(close, 120));
  // 清單開著時，方向鍵／Enter／Tab／Esc 歸清單；capture 讓它先於輸入框原本的「Enter 送出」。
  input.addEventListener('keydown', event => {
    if (list.hidden) return;
    if (event.key === 'Enter' || event.key === 'Tab') {
      const live = input.selectionStart === input.selectionEnd ? mentionAt(input.value, input.selectionStart ?? 0) : null;
      // Navigated out of the reference: the keys keep their usual meaning (send, focus move) instead of completing.
      if (!live || live.start !== current?.start) { close(); return; }
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      index = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render();
    } else if ((event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) || event.key === 'Tab') {
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(index);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }, true);
  return list;
}
