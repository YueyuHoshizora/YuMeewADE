import type { EditorDocument, EditorAction, EditorActionResult, EditorChange, EditorMutation, EditorSearchResult, EditorProblem, EditorRecovery, TaskContext } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, input, area, button, row, confirmModal, run } from './dom.ts';
import { EditorContent } from './editor-engine.ts';
import { FilePreview, isImage } from './file-preview.ts';
import { selectionMention } from './editor-mention.ts';

const browsers = new Map<string, { dialog: HTMLDialogElement; open: (path: string, line?: number) => Promise<void> }>();

window.addEventListener('yumeewade:open-file', event => {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== 'object') return;
  const { project, task, path, line } = detail as Record<string, unknown>;
  if (typeof project !== 'string' || !project || typeof task !== 'string' || typeof path !== 'string' || !path ||
    (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1))) return;
  openFileBrowser(project, task);
  const browser = browsers.get(JSON.stringify([project, task]));
  if (browser) void run(() => browser.open(path, line as number | undefined));
});

export function openFileBrowser(project: string, task: string): void {
  const key = JSON.stringify([project, task]); const existing = browsers.get(key);
  if (existing) { if (existing.dialog.open) existing.dialog.focus(); return; }
  const ids: Record<string, string> = { project, ...(task ? { task } : {}) }; let storageKey = ''; let persistenceEnabled = false;
  const buffers = new Map<string, EditorRecovery>(); const views: { path: string | undefined; content: EditorContent; preview: FilePreview; tabs: HTMLDivElement; node: HTMLDivElement }[] = [];
  const dialog = el('dialog', 'modal'); const results = el('div'); const output = el('div'); const panes = el('div'); panes.style.display = 'flex'; panes.style.gap = '1rem'; let focused = 0;
  const filter = input('', t('files.search')); const sourceSearch = input('', t('ew.search')); const replacement = input('', t('ew.replacement'));
  const dirty = (buffer: EditorRecovery) => buffer.text !== buffer.document.text;
  let persistenceTimer: number | undefined;
  function schedulePersist(): void {
    if (!persistenceEnabled) return;
    window.clearTimeout(persistenceTimer); persistenceTimer = window.setTimeout(persist, 200);
  }
  function persist(): void {
    window.clearTimeout(persistenceTimer);
    if (!storageKey || !persistenceEnabled) return;
    try {
      const recovery = [...buffers.values()].sort((a, b) => Number(dirty(b)) - Number(dirty(a))).map(buffer => dirty(buffer) ? buffer : {
        document: { ...buffer.document, text: '' }, text: '', clean: true,
        start: buffer.start, end: buffer.end, top: buffer.top, left: buffer.left
      });
      const state = { version: 3, buffers: recovery, panes: views.map(view => ({ path: view.path ?? null, start: view.content.selectionStart, end: view.content.selectionEnd, top: view.content.scrollTop, left: view.content.scrollLeft })), focused };
      let data = JSON.stringify(state); let omitted = false;
      while (new TextEncoder().encode(data).byteLength > 4 * 1024 * 1024 && recovery.length && 'clean' in recovery.at(-1)!) {
        recovery.pop(); omitted = true; data = JSON.stringify(state);
      }
      if (new TextEncoder().encode(data).byteLength > 4 * 1024 * 1024) throw new Error(t('ew.recoveryLimit'));
      if (omitted) output.append(el('p', 'warning', t('ew.recoveryLimit')));
      localStorage.setItem(storageKey, data);
    } catch { output.replaceChildren(el('p', 'warning', t('ew.recoveryLimit'))); }
  }
  function capture(index: number): void { const view = views[index]!; const buffer = view.path ? buffers.get(view.path) : undefined; if (buffer && !isImage(buffer.document.path)) { buffer.text = view.content.value; buffer.start = view.content.selectionStart; buffer.end = view.content.selectionEnd; buffer.top = view.content.scrollTop; buffer.left = view.content.scrollLeft; } }
  function refreshTabs(): void {
    for (const view of views) view.tabs.replaceChildren(...[...buffers].map(([path, buffer]) => row(
      button(`${path}${dirty(buffer) ? ' *' : ''}`, () => activate(path, views.indexOf(view))),
      button(t('common.close'), async () => {
        views.forEach((_, index) => capture(index));
        if (dirty(buffer) && !(await confirmModal(t('editor.dirty'), path, t('editor.discard')))) return;
        buffers.delete(path);
        for (const item of views) { item.content.forget(path); if (item.path === path) { item.path = undefined; item.content.value = ''; item.content.readOnly = true; item.preview.clear(); } }
        persist(); refreshTabs();
      })
    )));
  }
  function activate(path: string, index = focused, line?: number, character = 0): void {
    capture(index); const buffer = buffers.get(path); if (!buffer) return;
    const view = views[index]!; view.path = path; view.content.open(path, buffer.text); view.content.readOnly = isImage(path) || buffer.document.readonly || buffer.document.binary || buffer.document.truncated;
    view.preview.open(path, buffer.text, buffer.document.size);
    if (line === undefined) {
      view.content.setSelectionRange(buffer.start, buffer.end); view.content.scrollTop = buffer.top; view.content.scrollLeft = buffer.left;
    } else view.content.revealLine(line + 1, character);
    if (!isImage(path)) view.content.focus(); focused = index; refreshTabs();
    capture(index); schedulePersist();
    if (view.content.readOnly && !isImage(path)) output.replaceChildren(el('p', 'warning', buffer.document.binary ? t('files.binary') : buffer.document.truncated ? t('files.truncated') : t('detail.editor_readonly')));
  }
  let openSerial = 0;
  async function show(path: string, line?: number, character = 0): Promise<void> {
    const serial = ++openSerial; const index = focused;
    if (!buffers.has(path)) {
      if (buffers.size >= 50) throw new Error(t('ew.recoveryLimit'));
      const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path }));
      if (!dialog.isConnected) return;
      if (!buffers.has(path)) buffers.set(path, { document, text: document.text, start: 0, end: 0, top: 0, left: 0 });
    }
    if (serial === openSerial && dialog.isConnected) activate(path, index, line, character);
  }
  function pane(): void {
    const index = views.length; const code = el('div', 'editor-code'); const content = new EditorContent(code, t('editor.content'));
    const tabs = el('div'); const node = el('div'); const body = el('div'); const preview = new FilePreview(code, ids); body.append(code, preview.node); node.style.minWidth = '0'; node.style.flex = '1'; node.append(tabs, body); views.push({ path: undefined, content, preview, tabs, node }); panes.append(node);
    schedulePersist();
    content.complete = async context => {
      const path = views[index]!.path; const buffer = path ? buffers.get(path) : undefined;
      if (!buffer?.document.languageAvailable || content.readOnly) return null;
      const word = context.matchBefore(/[\w$]+/); if (!context.explicit && !word) return null;
      const line = context.state.doc.lineAt(context.pos);
      try {
        const result = await request<EditorActionResult>('/api/editor/language', { ...ids, path, text: context.state.doc.toString(), line: line.number - 1, character: context.pos - line.from, action: 'completion' });
        if (context.aborted || content.value !== context.state.doc.toString()) return null;
        return { from: word?.from ?? context.pos, options: (result.suggestions ?? []).map(item => ({ label: item.label, ...(item.detail ? { detail: item.detail } : {}), apply: (view, _completion, from, to) => view.dispatch({ changes: { from: item.start ?? from, to: item.end ?? to, insert: item.insertText } }) })) };
      } catch { return null; }
    };
    content.onfocus = () => { focused = index; schedulePersist(); };
    content.oninput = () => {
      capture(index); const path = views[index]!.path;
      for (let other = 0; other < views.length; other++) if (other !== index && views[other]!.path === path && path) {
        const sibling = views[other]!; const start = sibling.content.selectionStart; const end = sibling.content.selectionEnd; const top = sibling.content.scrollTop; const left = sibling.content.scrollLeft;
        sibling.content.value = content.value; sibling.content.setSelectionRange(start, end); sibling.content.scrollTop = top; sibling.content.scrollLeft = left;
        sibling.preview.update(content.value);
      }
      views[index]!.preview.update(content.value);
      schedulePersist(); refreshTabs();
    };
    content.onscroll = () => { capture(index); schedulePersist(); };
    content.onselect = () => { capture(index); schedulePersist(); };
    content.onkeydown = event => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.shiftKey && event.key.toLowerCase() === 'l' && task) { event.preventDefault(); sendSelection(); }
      else if (!event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); void run(save); }
    };
  }
  function current(): EditorRecovery | undefined { capture(focused); const path = views[focused]!.path; return path ? buffers.get(path) : undefined; }
  async function save(): Promise<void> { const buffer = current(); if (!buffer || !dirty(buffer)) return; const text = buffer.text; buffer.document = await request<EditorDocument>('/api/editor/save', { ...ids, path: buffer.document.path, text, revision: buffer.document.revision }); persist(); refreshTabs(); }
  function sendSelection(): void {
    if (!task) return;
    const view = views[focused]!; if (!view.path) return;
    const { doc, selection } = view.content.view.state; const primary = selection.main;
    const text = selectionMention(view.path, doc.lineAt(primary.from).number, doc.lineAt(primary.to).number, primary.empty);
    window.dispatchEvent(new CustomEvent('yumeewade:compose-insert', { detail: { project, task, text } }));
  }
  async function pin(path: string, start: number, end: number, revision: string): Promise<void> {
    if (!task) return;
    const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path }));
    if (document.revision !== revision) throw new Error(t('detail.editor_conflict'));
    const context = await request<TaskContext>(query('/api/task/context', ids));
    if (!context.sources.some(source => source.path === path && source.start === start && source.end === end)) context.sources.push({ path, start, end });
    const checked = await request<EditorDocument>(query('/api/editor/file', { ...ids, path }));
    if (checked.revision !== revision) throw new Error(t('detail.editor_conflict'));
    await request('/api/task/context', { ...ids, context });
  }
  async function apply(changes: EditorChange[]): Promise<void> {
    if (changes.some(change => { const buffer = buffers.get(change.path); return buffer && dirty(buffer); })) throw new Error(t('ew.saveFirst'));
    const preview = area(changes.map(change => `${change.path}\n${change.text}`).join('\n\n')); preview.readOnly = true;
    output.replaceChildren(preview, button(t('ew.apply'), async () => {
      if (!(await confirmModal(t('ew.apply'), t('ew.confirm'), t('ew.apply')))) return;
      views.forEach((_, index) => capture(index));
      if (changes.some(change => { const buffer = buffers.get(change.path); return buffer && dirty(buffer); })) throw new Error(t('ew.saveFirst'));
      const snapshots = new Map(changes.map(change => [change.path, buffers.get(change.path)?.text]));
      const documents = await request<EditorDocument[]>('/api/editor/apply', { ...ids, changes });
      views.forEach((_, index) => capture(index));
      for (const document of documents) { const buffer = buffers.get(document.path); if (buffer) { const unchanged = buffer.text === snapshots.get(document.path); buffer.document = document; if (unchanged) buffer.text = document.text; } }
      for (let index = 0; index < views.length; index++) { const path = views[index]!.path; if (path) { views[index]!.path = undefined; activate(path, index); } }
      persist(); output.replaceChildren();
    }));
  }
  const newName = input('', t('ew.newName'));
  async function language(action: EditorAction): Promise<void> {
    const buffer = current(); if (!buffer) return; const snapshot = buffer.text; const start = buffer.start; const end = buffer.end; const before = snapshot.slice(0, start).split('\n');
    const result = await request<EditorActionResult>('/api/editor/language', { ...ids, path: buffer.document.path, text: buffer.text, line: before.length - 1, character: before.at(-1)!.length, action, newName: newName.value });
    output.replaceChildren(...result.locations.map(location => button(`${location.path}:${location.line + 1}`, () => show(location.path, location.line, location.character))), ...result.diagnostics.map(item => button(`${item.line + 1} ${item.message}`, () => show(buffer.document.path, item.line, item.character))));
    if (result.hover) output.append(el('pre', '', result.hover));
    for (const suggestion of result.suggestions ?? []) output.append(button(`${suggestion.label} ${suggestion.detail ?? ''}`, () => {
      if (buffer.text !== snapshot) throw new Error(t('detail.editor_conflict'));
      activate(buffer.document.path);
      const view = views[focused]!; view.content.setRangeText(suggestion.insertText, suggestion.start ?? start, suggestion.end ?? end, 'end'); view.content.dispatchEvent(new Event('input'));
    }));
    if (result.changes?.length) await apply(result.changes);
    for (const action of result.actions ?? []) output.append(button(action.title, () => apply(action.changes)));
  }
  let loadSerial = 0;
  async function load(): Promise<void> {
    const serial = ++loadSerial; const q = filter.value.trim();
    const found = await request<{ files: string[]; total: number }>(query('/api/task/files', { ...ids, q }));
    if (serial !== loadSerial || !dialog.isConnected || q !== filter.value.trim()) return;
    results.replaceChildren(...found.files.map(path => button(path, () => show(path), 'file-result')));
    if (found.total > found.files.length) results.append(el('p', 'muted', t('files.more', { total: found.total, n: found.files.length })));
  }
  async function search(replace: boolean): Promise<void> {
    const needle = sourceSearch.value; const found = await request<EditorSearchResult>(query('/api/editor/search', { ...ids, q: needle }));
    output.replaceChildren(...found.hits.map(hit => row(button(`${hit.path}:${hit.line + 1} ${hit.preview}`, () => show(hit.path, hit.line, hit.character)), ...(task ? [button(t('ew.pin'), () => pin(hit.path, hit.line + 1, hit.line + Math.max(1, needle.split('\n').length), hit.revision))] : []))));
    if (replace) { const changes: EditorChange[] = []; for (const path of new Set(found.hits.map(hit => hit.path))) { const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path })); if (found.hits.some(hit => hit.path === path && hit.revision !== document.revision)) throw new Error(t('detail.editor_conflict')); changes.push({ path, revision: document.revision, text: document.text.split(needle).join(replacement.value) }); } if (changes.length) await apply(changes); }
  }
  const pathInput = input('', t('ew.path')); const destination = input('', t('ew.destination'));
  async function mutate(action: EditorMutation['action']): Promise<void> {
    const path = pathInput.value; const mutation: EditorMutation = { action, path, destination: destination.value };
    if (action === 'delete' || action === 'rename') {
      if ([...buffers.values()].some(buffer => dirty(buffer) && (buffer.document.path === path || buffer.document.path.startsWith(`${path}/`)))) throw new Error(t('ew.saveFirst'));
      mutation.confirmation = path;
      try { mutation.revision = (await request<EditorDocument>(query('/api/editor/file', { ...ids, path }))).revision; }
      catch { mutation.revision = (await request<{ revision: string }>(query('/api/editor/folder', { ...ids, path }))).revision; }
      if (!(await confirmModal(`${t('ew.confirm')} ${path}`, path, t(`ew.${action}`)))) return;
    }
    await request('/api/editor/mutate', { ...ids, ...mutation });
    if (action === 'delete' || action === 'rename') {
      for (const key of buffers.keys()) if (key === path || key.startsWith(`${path}/`)) { buffers.delete(key); views.forEach(view => view.content.forget(key)); }
      for (const view of views) if (view.path && (view.path === path || view.path.startsWith(`${path}/`))) { view.path = undefined; view.content.value = ''; view.content.readOnly = true; view.preview.clear(); }
      persist(); refreshTabs();
    }
    await load();
  }
  async function recover(): Promise<void> {
    let raw: string | null;
    try { raw = localStorage.getItem(storageKey); }
    catch { output.append(el('p', 'warning', t('ew.recoveryLimit'))); return; }
    if (!raw) return;
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { output.append(el('p', 'warning', t('ew.recoveryLimit'))); return; }
    const session = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as { version?: unknown; buffers?: unknown; panes?: unknown; focused?: unknown } : undefined;
    const values = Array.isArray(parsed) ? parsed : session?.version === 3 ? session.buffers : undefined;
    if (!Array.isArray(values) || values.length > 50 || new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024) { output.append(el('p', 'warning', t('ew.recoveryLimit'))); return; }
    if (values.some(value => value && typeof value === 'object' && !('clean' in value && value.clean === true)) && !(await confirmModal(t('ew.recover'), t('ew.recover'), t('ew.recover')))) { dialog.close(); return; }
    for (const value of values) { if (!value || typeof value !== 'object') continue; const candidate = value as Partial<EditorRecovery> & { clean?: boolean }; if (!candidate.document || typeof candidate.document.path !== 'string' || typeof candidate.document.revision !== 'string' || typeof candidate.text !== 'string' || candidate.text.length > 4 * 1024 * 1024) continue;
      const original = candidate.document;
      if (typeof original.text !== 'string') continue;
      const recovered: EditorRecovery = { document: original, text: candidate.text, start: Number.isSafeInteger(candidate.start) ? candidate.start! : 0, end: Number.isSafeInteger(candidate.end) ? candidate.end! : 0, top: typeof candidate.top === 'number' ? candidate.top : 0, left: typeof candidate.left === 'number' ? candidate.left : 0 };
      buffers.set(original.path, recovered);
      try {
        const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path: original.path }));
        const conflict = !candidate.clean && document.revision !== original.revision;
        recovered.document = conflict ? { ...document, text: original.text, revision: original.revision } : document;
        if (candidate.clean) recovered.text = document.text;
        if (conflict) output.append(row(el('p', 'warning', `${document.path}: ${t('ew.recoveryConflict')}`), button(t('ew.rebase'), async () => {
          const latest = await request<EditorDocument>(query('/api/editor/file', { ...ids, path: document.path }));
          const preview = area(latest.text); preview.readOnly = true; output.append(preview);
          if (!(await confirmModal(t('ew.rebase'), t('ew.confirm'), t('ew.rebase')))) return;
          recovered.document = latest; persist(); refreshTabs();
        })));
      } catch { recovered.document = { ...original, readonly: true }; output.append(el('p', 'warning', `${original.path}: ${t('ew.recoveryConflict')}`)); }
    }
    refreshTabs();
    const savedPanes = session?.version === 3 && Array.isArray(session.panes) && session.panes.length > 0 && session.panes.length <= 2 ? session.panes : [];
    while (views.length < savedPanes.length) pane();
    for (let index = 0; index < savedPanes.length; index++) {
      const saved = savedPanes[index] as { path?: unknown; start?: unknown; end?: unknown; top?: unknown; left?: unknown };
      if (!saved || typeof saved.path !== 'string' || !buffers.has(saved.path)) continue;
      activate(saved.path, index);
      const view = views[index]!;
      const start = typeof saved.start === 'number' && Number.isSafeInteger(saved.start) && saved.start >= 0 ? saved.start : 0;
      const end = typeof saved.end === 'number' && Number.isSafeInteger(saved.end) && saved.end >= start ? saved.end : start;
      view.content.setSelectionRange(start, end);
      view.content.scrollTop = typeof saved.top === 'number' && Number.isFinite(saved.top) && saved.top >= 0 ? saved.top : 0;
      view.content.scrollLeft = typeof saved.left === 'number' && Number.isFinite(saved.left) && saved.left >= 0 ? saved.left : 0;
    }
    if (savedPanes.length) {
      focused = typeof session?.focused === 'number' && Number.isSafeInteger(session.focused) && session.focused >= 0 && session.focused < views.length ? session.focused : 0;
      views[focused]!.content.focus();
    } else { const first = buffers.keys().next().value; if (first) activate(first); }
  }
  pane();
  const send = button(t('editorEvents.send'), sendSelection);
  send.disabled = !task; send.title = t(task ? 'editorEvents.shortcut' : 'editorEvents.noTask');
  const actions = row(button(t('common.save'), save), button(t('ew.split'), () => { if (views.length < 2) { capture(focused); const path = views[focused]!.path; pane(); if (path) activate(path, 1); refreshTabs(); } }), ...(['definition', 'references', 'diagnostics', 'completion', 'hover', 'rename', 'format', 'codeActions'] as const).map(action => button(t(action === 'definition' || action === 'references' || action === 'diagnostics' ? `editor.${action}` : `ew.${action}`), () => language(action))), newName,
    button(t('ew.problems'), async () => { const problems = await request<EditorProblem[]>(query('/api/editor/problems', ids)); output.replaceChildren(...problems.map(problem => button(`${problem.path}:${problem.line + 1} ${problem.message}`, () => show(problem.path, problem.line, problem.character)))); }), ...(task ? [button(t('ew.pin'), async () => {
      const buffer = current(); if (!buffer) return;
      if (dirty(buffer)) throw new Error(t('ew.saveFirst'));
      await pin(buffer.document.path, buffer.text.slice(0, buffer.start).split('\n').length, buffer.text.slice(0, buffer.end).split('\n').length, buffer.document.revision);
    })] : []));
  actions.append(send);
  const close = async () => { views.forEach((_, index) => capture(index)); persist(); dialog.close(); };
  filter.oninput = () => void run(load);
  const unload = (event: BeforeUnloadEvent) => { views.forEach((_, index) => capture(index)); persist(); if ([...buffers.values()].some(dirty)) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload); const navigate = () => void run(close); window.addEventListener('hashchange', navigate);
  dialog.addEventListener('cancel', event => { event.preventDefault(); void run(close); }); dialog.addEventListener('close', () => { browsers.delete(key); window.clearTimeout(persistenceTimer); views.forEach(view => { view.content.destroy(); view.preview.destroy(); }); window.removeEventListener('beforeunload', unload); window.removeEventListener('hashchange', navigate); dialog.remove(); }, { once: true });
  dialog.append(row(el('h2', '', t('files.title')), button(t('common.close'), close)), actions, row(pathInput, destination, ...(['createFile', 'createFolder', 'rename', 'delete'] as const).map(action => button(t(`ew.${action}`), () => mutate(action)))), row(sourceSearch, replacement, button(t('ew.search'), () => search(false)), button(t('ew.replacePreview'), () => search(true))), filter, results, panes, output);
  document.body.append(dialog);
  const ready = (async () => {
    const { scope } = await request<{ scope: string }>(query('/api/editor/scope', ids));
    if (!dialog.isConnected) return;
    storageKey = `editor-recovery:v2:${scope}`;
    dialog.showModal(); await recover();
    if (!dialog.isConnected) return;
    persistenceEnabled = true;
  })().catch(error => { dialog.dispatchEvent(new Event('close')); throw error; });
  browsers.set(key, { dialog, open: async (path, line) => { await ready; if (dialog.isConnected) await show(path, line === undefined ? undefined : line - 1); } });
  void run(async () => { await ready; await load(); });
}
