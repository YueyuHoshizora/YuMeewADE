import type { EditorDocument, EditorLanguageResult } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, input, area, button, row, confirmModal, run } from './dom.ts';
import { highlightCode } from './editor-syntax.ts';

export function openFileBrowser(project: string, task: string): void {
  const search = input(''); search.type = 'search'; search.placeholder = t('files.search'); search.setAttribute('aria-label', t('files.search'));
  const status = el('p', 'muted'); const results = el('ul', 'file-results'); const title = el('strong', 'file-title'); const note = el('p', 'warning');
  const content = area(); content.rows = 24; content.wrap = 'off'; content.spellcheck = false; content.className = 'editor-input'; content.setAttribute('aria-label', t('editor.content'));
  const syntax = el('div', 'editor-syntax'); syntax.setAttribute('aria-hidden', 'true');
  const code = el('div', 'editor-code'); code.append(syntax, content);
  content.onscroll = () => { syntax.scrollTop = content.scrollTop; syntax.scrollLeft = content.scrollLeft; };
  const languageResults = el('div');
  let current: EditorDocument | undefined; let dirty = false; let serial = 0; let openSerial = 0;
  const dialog = el('dialog', 'modal');
  function render(): void { dirty = !!current && content.value !== current.text; title.textContent = `${current?.path ?? ''}${dirty ? ' *' : ''}`; save.disabled = !dirty || content.readOnly; syntax.replaceChildren(highlightCode(content.value, current?.language ?? 'plaintext')); }
  async function canDiscard(): Promise<boolean> { return !dirty || confirmModal(t('editor.dirty'), t('editor.discard'), t('common.close')); }
  async function show(file: string, line = 0, character = 0): Promise<void> {
    if (!(await canDiscard())) return;
    const mine = ++openSerial;
    const beforeLoad = content.value;
    const view = await request<EditorDocument>(query('/api/editor/file', { project, task, path: file }));
    if (mine !== openSerial || !dialog.isConnected) return;
    if (content.value !== beforeLoad && !(await canDiscard())) return;
    current = view; content.value = view.text; content.readOnly = view.readonly || view.binary || view.truncated;
    note.textContent = view.binary ? t('files.binary') : view.truncated ? t('files.truncated') : view.readonly ? t('detail.editor_readonly') : !view.languageAvailable ? t('editor.unavailable') : '';
    note.hidden = !note.textContent;
    languageResults.replaceChildren(); render(); content.focus();
    const lines = view.text.split('\n'); const offset = lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0) + character;
    content.setSelectionRange(offset, offset); content.scrollTop = line * 20;
  }
  const save = button(t('common.save'), async () => {
    if (!current || !dirty || content.readOnly) return;
    const snapshot = content.value; const original = current;
    const saved = await request<EditorDocument>('/api/editor/save', { project, task, path: original.path, text: snapshot, revision: original.revision });
    if (current === original) { current = saved; render(); }
  });
  async function language(action: 'definition' | 'references' | 'diagnostics'): Promise<void> {
    if (!current || current.binary || current.truncated) return;
    const before = content.value.slice(0, content.selectionStart); const lines = before.split('\n');
    const result = await request<EditorLanguageResult>('/api/editor/language', { project, task, path: current.path, text: content.value, action, line: lines.length - 1, character: lines.at(-1)!.length });
    languageResults.replaceChildren(...result.locations.map(location => button(`${location.path}:${location.line + 1}:${location.character + 1}`, () => show(location.path, location.line, location.character))), ...result.diagnostics.map(diagnostic => button(`${diagnostic.line + 1}:${diagnostic.character + 1} ${diagnostic.message}`, () => { const offset = content.value.split('\n').slice(0, diagnostic.line).reduce((sum, value) => sum + value.length + 1, 0) + diagnostic.character; content.focus(); content.setSelectionRange(offset, offset); content.scrollTop = diagnostic.line * 20; })));
    if (!result.locations.length && !result.diagnostics.length) languageResults.append(el('p', 'muted', t('editor.noResults')));
  }
  content.oninput = render;
  content.onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void run(async () => { save.click(); }); } };
  async function load(): Promise<void> {
    const mine = ++serial;
    const found = await request<{ files: string[]; total: number }>(query('/api/task/files', { project, task, q: search.value.trim() }));
    if (mine !== serial || !dialog.isConnected) return;
    status.textContent = found.files.length === 0 ? t('files.empty') : found.total > found.files.length ? t('files.more', { total: found.total, n: found.files.length }) : '';
    results.replaceChildren(...found.files.map(file => { const item = el('li'); item.append(button(file, () => show(file), 'file-result')); return item; }));
  }
  let timer: number | undefined;
  search.oninput = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void run(load), 150); };
  const list = el('div', 'file-list'); list.append(search, status, results);
  const pane = el('div', 'file-pane'); pane.append(title, note, row(save, button(t('editor.definition'), () => language('definition')), button(t('editor.references'), () => language('references')), button(t('editor.diagnostics'), () => language('diagnostics'))), code, languageResults);
  const viewer = el('div', 'file-viewer'); viewer.append(list, pane);
  const close = async () => { if (await canDiscard()) dialog.close(); };
  const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
  const hash = location.hash;
  const navigate = (event: HashChangeEvent) => { if (dirty) { event.stopImmediatePropagation(); const destination = location.hash; history.replaceState(null, '', hash); void run(async () => { if (await canDiscard()) { dirty = false; dialog.close(); location.hash = destination; } }); } else dialog.close(); };
  window.addEventListener('beforeunload', unload); window.addEventListener('hashchange', navigate, true);
  dialog.addEventListener('cancel', event => { event.preventDefault(); void run(close); });
  dialog.addEventListener('close', () => { window.clearTimeout(timer); ++serial; ++openSerial; window.removeEventListener('beforeunload', unload); window.removeEventListener('hashchange', navigate, true); dialog.remove(); }, { once: true });
  dialog.append(row(el('h2', '', t('files.title')), button(t('common.close'), close)), viewer); document.body.append(dialog); dialog.showModal(); render(); void run(load);
}
