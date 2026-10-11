import type { SlashCommand } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import { applySlash, slashAt } from './slash.ts';

export function attachSlashCommands(
  input: HTMLTextAreaElement,
  context: () => string,
  load: () => Promise<SlashCommand[]>,
): { node: HTMLElement; refresh: () => void; dispose: () => void } {
  const node = document.createElement('div');
  node.className = 'slash-menu';
  node.hidden = true;
  const label = document.createElement('div');
  label.className = 'slash-label';
  label.textContent = t('slash.title');
  const list = document.createElement('ul');
  list.className = 'slash-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('slash.title'));
  const status = document.createElement('p');
  status.className = 'slash-status';
  status.setAttribute('role', 'status');
  node.append(label, list, status);
  let key = '';
  let commands: SlashCommand[] | null = null;
  let items: SlashCommand[] = [];
  let index = 0;
  let serial = 0;
  let pending = false;
  let failed = false;
  let disposed = false;
  let dismissed = false;
  const close = () => { node.hidden = true; items = []; };
  const render = () => {
    const token = input.selectionStart === input.selectionEnd ? slashAt(input.value, input.selectionStart) : null;
    if (disposed || dismissed || document.activeElement !== input || !token) { close(); return; }
    items = (commands ?? []).filter(command => command.name.toLowerCase().startsWith(token.query.toLowerCase()));
    index = Math.min(index, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((command, i) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === index));
      item.classList.toggle('active', i === index);
      const name = document.createElement('strong');
      name.textContent = `/${command.name}`;
      item.append(name);
      if (command.argumentHint) {
        const hint = document.createElement('span');
        hint.className = 'slash-arguments';
        hint.textContent = command.argumentHint;
        item.append(hint);
      }
      if (command.description) {
        const description = document.createElement('div');
        description.className = 'slash-description';
        description.textContent = command.description;
        item.append(description);
      }
      item.onmousedown = event => { event.preventDefault(); choose(i); };
      return item;
    }));
    status.textContent = pending ? t('slash.loading') : failed ? t('slash.error') : !commands?.length ? t('slash.empty') : !items.length ? t('slash.noMatch') : t('slash.keys');
    node.hidden = false;
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  function choose(i: number): void {
    const command = items[i];
    const token = slashAt(input.value, input.selectionStart);
    if (!command || !token || input.selectionStart !== input.selectionEnd) return;
    const applied = applySlash(input.value, token, command.name);
    input.value = applied.text;
    input.setSelectionRange(applied.caret, applied.caret);
    close();
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
  const refresh = () => {
    if (disposed) return;
    const next = context();
    if (next !== key) {
      key = next;
      serial++;
      commands = null;
      pending = false;
      failed = false;
      index = 0;
      dismissed = false;
    }
    if (!dismissed && document.activeElement === input && slashAt(input.value, input.selectionStart) && !commands && !pending && !failed) {
      pending = true;
      const mine = ++serial;
      void load().then(found => {
        if (disposed || mine !== serial) return;
        commands = found;
        pending = false;
        render();
      }, () => {
        if (disposed || mine !== serial) return;
        pending = false;
        failed = true;
        render();
      });
    }
    render();
  };
  const edit = () => { dismissed = false; index = 0; refresh(); };
  const focus = () => { dismissed = false; refresh(); };
  const blur = () => close();
  const keyup = (event: KeyboardEvent) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) edit(); };
  const keydown = (event: KeyboardEvent) => {
    if (node.hidden || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismissed = true;
      close();
    } else if (items.length && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        index = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        render();
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(index);
      }
    }
  };
  input.addEventListener('input', edit);
  input.addEventListener('click', edit);
  input.addEventListener('focus', focus);
  input.addEventListener('blur', blur);
  input.addEventListener('keyup', keyup);
  input.addEventListener('keydown', keydown, true);
  return {
    node, refresh,
    dispose: () => {
      disposed = true;
      serial++;
      close();
      input.removeEventListener('input', edit);
      input.removeEventListener('click', edit);
      input.removeEventListener('focus', focus);
      input.removeEventListener('blur', blur);
      input.removeEventListener('keyup', keyup);
      input.removeEventListener('keydown', keydown, true);
    },
  };
}
