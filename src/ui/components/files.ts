import type { FileView } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, input, modal, run } from './dom.ts';

/** 唯讀檔案瀏覽：依檔名搜尋，點檔案看內容（副本裡的版本；沒有副本就看主資料夾）。 */
export function openFileBrowser(project: string, task: string): void {
  const search = input('');
  search.type = 'search';
  search.placeholder = t('files.search');
  search.setAttribute('aria-label', t('files.search'));
  const status = el('p', 'muted');
  const results = el('ul', 'file-results');
  const title = el('strong', 'file-title');
  const note = el('p', 'warning');
  note.hidden = true;
  const content = el('pre', 'file-content');
  let serial = 0;
  async function show(file: string): Promise<void> {
    const view = await request<FileView>(query('/api/task/file', { project, task, path: file }));
    title.textContent = `${view.path} · ${view.size < 1024 ? `${view.size} B` : `${(view.size / 1024).toFixed(1)} KB`}`;
    note.hidden = !(view.binary || view.truncated);
    note.textContent = view.binary ? t('files.binary') : t('files.truncated');
    content.textContent = view.text;
    content.scrollTop = 0;
  }
  async function load(): Promise<void> {
    const mine = ++serial;
    const found = await request<{ files: string[]; total: number }>(query('/api/task/files', { project, task, q: search.value.trim() }));
    if (mine !== serial) return;
    status.textContent = found.files.length === 0 ? t('files.empty') : found.total > found.files.length ? t('files.more', { total: found.total, n: found.files.length }) : '';
    results.replaceChildren(...found.files.map(file => {
      const item = el('li');
      const open = el('button', 'file-result', file);
      open.type = 'button';
      open.onclick = () => void run(() => show(file));
      item.append(open);
      return item;
    }));
  }
  let timer: number | undefined;
  search.oninput = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void run(load), 150); };
  const list = el('div', 'file-list');
  list.append(search, status, results);
  const pane = el('div', 'file-pane');
  pane.append(title, note, content);
  const viewer = el('div', 'file-viewer');
  viewer.append(list, pane);
  modal(t('files.title'), viewer);
  void run(load);
}
