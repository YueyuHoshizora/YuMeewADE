import type { AppState, ArchivePreview } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/zh-TW.ts';
import { ApiFailure, request } from '../api.ts';
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = content; return node;
}
export function button(label: string, action: () => unknown, className = ''): HTMLButtonElement {
  const node = el('button', className, label); node.type = 'button';
  // Availability owned by the caller (see setLocked) survives the action, e.g. when the action re-renders and disables it.
  node.onclick = () => { void run(async () => { node.disabled = true; try { await action(); } finally { node.disabled = lockedButtons.has(node); } }); }; return node;
}
const lockedButtons = new WeakSet<HTMLButtonElement>();
/** Sets a button's caller-owned availability; `button()` keeps it after its own action finishes. */
export function setLocked(node: HTMLButtonElement, locked: boolean): void { node.disabled = locked; if (locked) lockedButtons.add(node); else lockedButtons.delete(node); }
export function iconButton(icon: string, label: string, action: () => unknown, className = ''): HTMLButtonElement {
  const node = button(icon, action, className);
  node.setAttribute('aria-label', label);
  return node;
}

export function statusRegion(): HTMLElement {
  const node = el('div', 'visually-hidden');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  return node;
}
// A placeholder is often the only visible description of a bare control, so it doubles as the accessible name
// until field() wraps the control in a visible label, which then names it instead.
export function input(value = '', placeholder = ''): HTMLInputElement {
  const node = el('input'); node.value = value; node.placeholder = placeholder; if (placeholder) node.setAttribute('aria-label', placeholder); return node;
}
export function area(value = '', placeholder = ''): HTMLTextAreaElement {
  const node = el('textarea'); node.value = value; node.placeholder = placeholder; node.rows = 4; if (placeholder) node.setAttribute('aria-label', placeholder); return node;
}
export function select(options: { value: string; label: string }[], value = ''): HTMLSelectElement {
  const node = el('select'); for (const o of options) { const opt = el('option', '', o.label); opt.value = o.value; node.append(opt); } node.value = value; return node;
}
export function field(label: string, control: HTMLElement): HTMLLabelElement {
  const placeholder = 'placeholder' in control ? (control as HTMLInputElement).placeholder : '';
  if (placeholder && control.getAttribute('aria-label') === placeholder) control.removeAttribute('aria-label');
  const node = el('label', 'field'); node.append(el('span', 'field-label', label), control); return node;
}
export function disclosure(title: string, ...children: Node[]): HTMLDetailsElement {
  const node = el('details', 'disclosure'); node.append(el('summary', '', title), ...children); return node;
}
export function row(...children: Node[]): HTMLDivElement { const node = el('div', 'row'); node.append(...children); return node; }
export function card(title: string, ...children: Node[]): HTMLElement { const node = el('section', 'card'); node.append(el('h2', '', title), ...children); return node; }
export function link(label: string, hash: string, className = ''): HTMLAnchorElement { const node = el('a', className, label); node.href = hash; return node; }
export const projectHash = (p: string) => `#/p/${encodeURIComponent(p)}`;
export const taskHash = (p: string, task: string) => `#/t/${encodeURIComponent(p)}/${encodeURIComponent(task)}`;
/** Search opened from a task page carries that task so the search page can offer to stay within it. */
export function searchHash(current = location.hash): string {
  const parts = (current.slice(1).split('?')[0] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
  return parts[0] === 't' && parts[1] && parts[2] ? `#/search?${new URLSearchParams({ project: parts[1], task: parts[2] })}` : '#/search';
}
export function toast(message: string): void { const node = document.getElementById('toast')!; node.textContent = message; node.hidden = false; window.setTimeout(() => { node.hidden = true; }, 5000); }
/** A failure whose message is already localized for the user (validation, stale draft, …). */
export class UserError extends Error {}
export function errorMessage(error: unknown): string {
  if (error instanceof UserError) return error.message;
  if (!(error instanceof ApiFailure)) return t('err.network');
  const key = (error.body.detail ? `detail.${error.body.detail}` : `err.${error.body.error}`) as MessageKey;
  return `${error.status} · ${t(key, { field: error.body.field ?? '' })}`;
}
export function showError(error: unknown): void {
  toast(errorMessage(error));
  if (error instanceof ApiFailure && error.body.conflicts?.length) modal(t('copy.conflict'), el('pre', '', error.body.conflicts.join('\n')));
}
export async function run(action: () => Promise<unknown>): Promise<void> { try { await action(); } catch (error) { showError(error); } }
export function modal(title: string, ...content: Node[]): void {
  const dialog = el('dialog', 'modal'); dialog.append(row(el('h2', '', title), button(t('common.close'), () => dialog.close())), ...content); dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
/** Escape、取消與關閉都會完成 Promise，不讓原生對話框阻塞 renderer。 */
export function confirmModal(title: string, message: string, acceptLabel: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const dialog = el('dialog', 'modal decision-modal'); let accepted = false;
  dialog.append(el('h2', '', title), el('p', '', message), row(
    button(t('common.cancel'), () => dialog.close()),
    button(acceptLabel, () => { accepted = true; dialog.close(); }, 'primary'),
  ));
  dialog.addEventListener('close', () => { dialog.remove(); resolve(accepted); }, { once: true });
  document.body.append(dialog); dialog.showModal();
  return promise;
}
/** 封存遇到工作副本時，先列出保存範圍，再確認移入私有恢復區；不合併。 */
export async function archiveFlow(path: string, ids: Record<string, string>, name: string, worktreeDetail: string): Promise<boolean> {
  if (!(await confirmModal(t('common.archive'), t('common.confirmArchive', { name }), t('common.archive')))) return false;
  try {
    await request(path, ids);
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.body.detail !== worktreeDetail) throw error;
    const query = new URLSearchParams(ids);
    const preview = await request<ArchivePreview>(`/api/archive/preview?${query}`);
    const message = [
      t('archive.safety', { name }),
      `${t('archive.git')}\n${preview.git.join('\n') || '—'}`,
      `${t('archive.preserved')}\n${preview.preserved.join('\n') || '—'}`,
      `${t('archive.unavailable')}\n${preview.unavailable.join('\n') || '—'}`,
    ].join('\n\n');
    if (preview.unavailable.length) { modal(t('common.archive'), el('pre', '', message)); return false; }
    if (!(await confirmModal(t('common.forceArchive'), message, t('common.forceArchive')))) return false;
    await request(path, { ...ids, force: true });
  }
  return true;
}
export function renameModal(value: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const dialog = el('dialog', 'modal decision-modal'); const name = input(value); name.required = true;
  const form = el('form', 'form'); const save = el('button', 'primary', t('common.save')); save.type = 'submit';
  let result: string | null = null;
  form.append(field(t('common.name'), name), row(button(t('common.cancel'), () => dialog.close()), save));
  form.onsubmit = event => { event.preventDefault(); if (name.value.trim()) { result = name.value.trim(); dialog.close(); } };
  dialog.append(el('h2', '', t('common.rename')), form);
  dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
  document.body.append(dialog); dialog.showModal(); name.focus(); name.select();
  return promise;
}
/** Multi-line counterpart of renameModal; resolves null on cancel. */
export function textModal(title: string, value: string, maxLength: number): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const dialog = el('dialog', 'modal decision-modal'); const text = area(value); text.maxLength = maxLength; text.rows = 6;
  const form = el('form', 'form'); const save = el('button', 'primary', t('common.save')); save.type = 'submit';
  let result: string | null = null;
  form.append(text, row(button(t('common.cancel'), () => dialog.close()), save));
  form.onsubmit = event => { event.preventDefault(); result = text.value.trim(); dialog.close(); };
  dialog.append(el('h2', '', title), form);
  dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
  document.body.append(dialog); dialog.showModal(); text.focus();
  return promise;
}
/** Single-choice counterpart of renameModal; resolves null on cancel. */
export function selectModal(title: string, label: string, options: { value: string; label: string }[], value: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const dialog = el('dialog', 'modal decision-modal'); const choice = select(options, value);
  const form = el('form', 'form'); const save = el('button', 'primary', t('common.save')); save.type = 'submit';
  let result: string | null = null;
  form.append(field(label, choice), row(button(t('common.cancel'), () => dialog.close()), save));
  form.onsubmit = event => { event.preventDefault(); result = choice.value; dialog.close(); };
  dialog.append(el('h2', '', title), form);
  dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
  document.body.append(dialog); dialog.showModal(); choice.focus();
  return promise;
}
/** Multi-choice counterpart of selectModal; resolves the checked values in option order, or null on cancel. */
export function checksModal(title: string, options: { value: string; label: string }[], checked: string[]): Promise<string[] | null> {
  const { promise, resolve } = Promise.withResolvers<string[] | null>();
  const dialog = el('dialog', 'modal decision-modal'); const grid = el('div', 'check-grid');
  const boxes = options.map(option => { const box = input(); box.type = 'checkbox'; box.value = option.value; box.checked = checked.includes(option.value); grid.append(field(option.label, box)); return box; });
  const form = el('form', 'form'); const save = el('button', 'primary', t('common.save')); save.type = 'submit';
  let result: string[] | null = null;
  form.append(options.length ? grid : el('p', 'muted', t('common.empty')), row(button(t('common.cancel'), () => dialog.close()), save));
  form.onsubmit = event => { event.preventDefault(); result = boxes.filter(box => box.checked).map(box => box.value); dialog.close(); };
  dialog.append(el('h2', '', title), form);
  dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
  document.body.append(dialog); dialog.showModal(); boxes[0]?.focus();
  return promise;
}
export function lines(value: string): string[] { return value.split('\n').map(s => s.trim()).filter(Boolean); }
export function readLocal<T>(key: string, fallback: T): T { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
export function storeLocal(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 儲存空間不足不阻止送出。 */ } }
export interface ViewContext { state: AppState; refresh: () => Promise<void>; }
export interface View { node: HTMLElement; dispose?: () => void; update?: (state: AppState) => void; }
