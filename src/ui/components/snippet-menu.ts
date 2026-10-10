import { t } from '../i18n/index.ts';
import { button, el, input, modal, readLocal, row, storeLocal, toast } from './dom.ts';
import { addSnippet, insertSnippet, removeSnippet, sanitizeSnippets } from './snippets.ts';

/** 常用指示：內建幾則，加上使用者自己存的（只存在這個瀏覽器／桌面 App 的 localStorage）。 */
const KEY = 'yumeewade.snippets';
const BUILTIN = ['plan', 'debug', 'tests', 'docs'] as const;

export function snippetsButton(draft: HTMLTextAreaElement): HTMLButtonElement {
  return button(t('snip.open'), () => {
    const dialog = el('div', 'snippet-list');
    const render = () => {
      const custom = sanitizeSnippets(readLocal<unknown>(KEY, []));
      const use = (text: string) => {
        draft.value = insertSnippet(draft.value, text);
        draft.dispatchEvent(new Event('input'));
        draft.focus();
        dialog.closest('dialog')?.close();
      };
      const item = (name: string, text: string, onRemove?: () => void) => {
        const line = row(button(name, () => use(text), 'snippet-use'));
        line.title = text;
        if (onRemove) line.append(button('×', onRemove, 'subtle'));
        return line;
      };
      const name = input('', t('snip.name'));
      name.maxLength = 40;
      const save = button(t('snip.save'), () => {
        if (!draft.value.trim()) return toast(t('snip.needDraft'));
        if (!name.value.trim()) return toast(t('snip.needName'));
        storeLocal(KEY, addSnippet(custom, name.value, draft.value));
        render();
      });
      dialog.replaceChildren(
        el('h3', '', t('snip.builtin')),
        ...BUILTIN.map(id => item(t(`snip.${id}.name`), t(`snip.${id}.text`))),
        el('h3', '', t('snip.custom')),
        ...(custom.length ? custom.map(s => item(s.name, s.text, () => { storeLocal(KEY, removeSnippet(custom, s.name)); render(); })) : [el('p', 'muted', t('snip.empty'))]),
        row(name, save));
    };
    render();
    modal(t('snip.open'), dialog);
  });
}
