import type { AppState } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/zh-TW.ts';
import { ApiFailure, request } from '../api.ts';
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = content; return node;
}
export function button(label: string, action: () => unknown, className = ''): HTMLButtonElement {
  const node = el('button', className, label); node.type = 'button';
  node.onclick = () => { void run(async () => { node.disabled = true; try { await action(); } finally { node.disabled = false; } }); }; return node;
}
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
export function input(value = '', placeholder = ''): HTMLInputElement {
  const node = el('input'); node.value = value; node.placeholder = placeholder; return node;
}
export function area(value = '', placeholder = ''): HTMLTextAreaElement {
  const node = el('textarea'); node.value = value; node.placeholder = placeholder; node.rows = 4; return node;
}
export function select(options: { value: string; label: string }[], value = ''): HTMLSelectElement {
  const node = el('select'); for (const o of options) { const opt = el('option', '', o.label); opt.value = o.value; node.append(opt); } node.value = value; return node;
}
export function field(label: string, control: HTMLElement): HTMLLabelElement {
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
export function toast(message: string): void { const node = document.getElementById('toast')!; node.textContent = message; node.hidden = false; window.setTimeout(() => { node.hidden = true; }, 5000); }
export function showError(error: unknown): void {
  if (error instanceof ApiFailure) {
    const key = (error.body.detail ? `detail.${error.body.detail}` : `err.${error.body.error}`) as MessageKey;
    toast(`${error.status} · ${t(key, { field: error.body.field ?? '' })}`);
    if (error.body.conflicts?.length) modal(t('copy.conflict'), el('pre', '', error.body.conflicts.join('\n')));
  } else toast(t('err.network'));
}
export async function run(action: () => Promise<unknown>): Promise<void> { try { await action(); } catch (error) { showError(error); } }
export function modal(title: string, ...content: Node[]): void {
  const dialog = el('dialog', 'modal'); dialog.append(row(el('h2', '', title), button(t('common.close'), () => dialog.close())), ...content); dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
/** Escape、取消與關閉都會完成 Promise，不讓原生對話框阻塞 renderer。 */
export function confirmModal(title: string, message: string, acceptLabel = t('common.save')): Promise<boolean> {
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
/** 封存：核心回報還有未合併的工作副本時，再問一次是否強制封存（副本移除、分支保留，不合併）。 */
export async function archiveFlow(path: string, ids: Record<string, string>, name: string, worktreeDetail: string): Promise<boolean> {
  if (!(await confirmModal(t('common.archive'), t('common.confirmArchive', { name }), t('common.archive')))) return false;
  try {
    await request(path, ids);
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.body.detail !== worktreeDetail) throw error;
    if (!(await confirmModal(t('common.forceArchive'), t('common.confirmForceArchive', { name }), t('common.forceArchive')))) return false;
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
export function lines(value: string): string[] { return value.split('\n').map(s => s.trim()).filter(Boolean); }
export function readLocal<T>(key: string, fallback: T): T { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
export function storeLocal(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 儲存空間不足不阻止送出。 */ } }
export interface ViewContext { state: AppState; refresh: () => Promise<void>; }
export interface View { node: HTMLElement; dispose?: () => void; update?: (state: AppState) => void; }
