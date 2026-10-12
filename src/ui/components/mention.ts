/** 輸入框的 `@檔名` 提及：判斷游標前的 @token、套用選擇、並管理候選清單。 */
import { mentionNeedsQuotes } from '../../shared/mention-syntax.ts';
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

/** `@path` reference text; a path the core would split (whitespace, CJK or trailing punctuation) is quoted. */
export function mentionText(target: string): string {
  return mentionNeedsQuotes(target) ? `@"${target}"` : `@${target}`;
}

export function applyMention(text: string, mention: Mention, caret: number, file: string): { text: string; caret: number } {
  const insert = `${mentionText(file)} `;
  return { text: text.slice(0, mention.start) + insert + text.slice(caret), caret: mention.start + insert.length };
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
    if (!current || file === undefined) return;
    const applied = applyMention(input.value, current, input.selectionStart ?? current.start + 1 + current.query.length, file);
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
