import type { EditorDiagnostic, EditorDocument, EditorAction, EditorActionResult, EditorChange, EditorMutation, EditorSearchResult, EditorProblem, EditorRecovery, TaskContext, EditorResolvedFormatPreferences } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { isolateHistory } from '@codemirror/commands';
import { t } from '../i18n/index.ts';
import { el, input, area, button, row, confirmModal, errorMessage, readLocal, run, storeLocal, toast, UserError } from './dom.ts';
import { EditorContent } from './editor-engine.ts';
import { FilePreview, isImage } from './file-preview.ts';
import { selectionMention } from './editor-mention.ts';
import { fileHierarchy, normalizeLayout, pendingProposalRanges } from './editor-layout.ts';
import { preferenceCommand, readPreferences, serializeEol } from './editor-preferences.ts';
import { debuggerWorkbench } from './debugger.ts';
import { mountEditorProposals } from './editor-proposals.ts';
import { renderAdvancedLanguage } from './editor-language-results.ts';
import { encodingPicker, segmentPanel } from './editor-segments.ts';
import { embeddedPreviewWorkbench } from './embedded-preview.ts';

export interface WorkbenchEditorHost {
  reserveSegment(path: string): (() => void) | null;
  refresh(path: string): Promise<void>;
  snapshot(): { path: string; revision: string; text: string; selection: { from: number; to: number } } | null;
  reserve(expected: { path: string; revision: string; text: string }): (() => void) | null;
  applyEdits(expected: { path: string; revision: string; text: string }, edits: { from: number; to: number; text: string }[]): boolean;
  snapshots(): { path: string; revision: string; text: string; selection: { from: number; to: number } }[];
  reserveAll(expected: { path: string; revision: string; text: string }[]): (() => void) | null;
  applyEditsAll(changes: { expected: { path: string; revision: string; text: string }; edits: { from: number; to: number; text: string }[] }[]): boolean;
}
export interface WorkbenchPanelContext { project: string; task: string; node: HTMLElement; open(path: string, line?: number): Promise<void>; editor: WorkbenchEditorHost; }
const panelFactories = new Map<string, (context: WorkbenchPanelContext) => HTMLElement>();
export function registerWorkbenchPanel(id: string, factory: (context: WorkbenchPanelContext) => HTMLElement): void {
  panelFactories.set(id, factory);
  window.dispatchEvent(new Event('yumeewade:workbench-panels'));
}
registerWorkbenchPanel('debugger', debuggerWorkbench);
registerWorkbenchPanel('proposals', mountEditorProposals);
registerWorkbenchPanel('segments', segmentPanel);
registerWorkbenchPanel('preview', embeddedPreviewWorkbench);
let workbenchMount: HTMLElement | undefined;
let activeWorkspace = '';
export function mountEditorWorkbench(main: HTMLElement): void {
  workbenchMount = el('section', 'editor-workbench-host');
  main.after(workbenchMount);
}
export function setWorkbenchScope(project: string, task: string, workspace: string): void {
  activeWorkspace = workspace;
  if (!project) return;
  for (const browser of browsers.values()) { browser.flush(); browser.dialog.hidden = true; }
  if (project) openFileBrowser(project, task, workspace);
}

const browsers = new Map<string, { dialog: HTMLElement; open: (path: string, line?: number) => Promise<void>; flush(): void; dispose(): void; canDispose(): boolean; restoreLayout(): void }>();
window.addEventListener('yumeewade:workspace-changed', () => { for (const browser of browsers.values()) browser.dispose(); browsers.clear(); });

window.addEventListener('yumeewade:open-file', event => {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== 'object') return;
  const { project, task, path, line } = detail as Record<string, unknown>;
  if (typeof project !== 'string' || !project || typeof task !== 'string' || typeof path !== 'string' || !path ||
    (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1))) return;
  openFileBrowser(project, task);
  const browser = browsers.get(JSON.stringify([activeWorkspace, project, task]));
  if (browser) void run(() => browser.open(path, line as number | undefined));
});

export function openFileBrowser(project: string, task: string, workspace = activeWorkspace): void {
  const key = JSON.stringify([workspace, project, task]); const existing = browsers.get(key);
  if (existing) { for (const browser of browsers.values()) { browser.flush(); browser.dialog.hidden = browser !== existing; } existing.dialog.hidden = false; existing.restoreLayout(); return; }
  for (const browser of browsers.values()) { browser.flush(); browser.dialog.hidden = true; }
  if (browsers.size >= 12) {
    const idle = [...browsers].find(([, browser]) => browser.canDispose());
    if (idle) { idle[1].dispose(); browsers.delete(idle[0]); }
  }
  if (browsers.size >= 12) throw new UserError(t('ew.recoveryLimit'));
  const ids: Record<string, string> = { project, ...(task ? { task } : {}) }; let storageKey = ''; let persistenceEnabled = false;
  const buffers = new Map<string, EditorRecovery>(); const views: { path: string | undefined; content: EditorContent; preview: FilePreview; tabs: HTMLDivElement; node: HTMLDivElement }[] = [];
  const formats = new Map<string, EditorResolvedFormatPreferences>();
  const dialog = el('section', 'editor-workbench'); const results = el('div', 'editor-file-tree'); const output = el('div', 'editor-problems'); const panes = el('div', 'editor-panes'); let focused = 0;
  const filter = input('', t('files.search')); const sourceSearch = input('', t('ew.search')); const replacement = input('', t('ew.replacement'));
  const searchOptions = el('div');
  const caseSensitive = input(); caseSensitive.type = 'checkbox';
  const wholeWord = input(); wholeWord.type = 'checkbox';
  const regex = input(); regex.type = 'checkbox';
  const include = input('', t('editorFront.include')); const exclude = input('', t('editorFront.exclude'));
  const mode = el('select'); mode.setAttribute('aria-label', t('editorFront.searchMode')); for (const value of ['content', 'files'] as const) { const option = el('option', '', t(value === 'content' ? 'editorFront.searchContent' : 'editorFront.searchFiles')); option.value = value; mode.append(option); }
  for (const [control, key] of [[caseSensitive, 'editorFront.case'], [wholeWord, 'editorFront.word'], [regex, 'editorFront.regex']] as const) { const label = el('label', '', t(key)); label.prepend(control); searchOptions.append(label); }
  searchOptions.append(include, exclude, mode);
  let searchPage = 1; let searchSerial = 0;
  const encoding = encodingPicker();
  const conflicts = new Map<string, EditorDocument>();
  const unresolved = new Set<string>();
  let editReserved = false;
  let pendingWrites = 0;
  let disposeDeferred = false;
  const conflictHost = el('div');
  const conflictPanels = new Map<string, HTMLElement>();
  function markUnresolved(path: string): void {
    unresolved.add(path); conflictPanels.get(path)?.remove();
    const resolve = el('div', 'editor-conflict');
    resolve.append(el('p', 'warning', `${path}: ${t('editorUI.unresolved')}`), button(t('ew.apply'), async () => {
      views.forEach((_, index) => capture(index));
      if (/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)(?: |$)/m.test(buffers.get(path)?.text ?? '')) throw new UserError(t('editorUI.unresolved'));
      if (!await confirmModal(t('ew.apply'), t('editorUI.unresolved'), t('ew.apply'))) return;
      unresolved.delete(path); resolve.remove(); conflictPanels.delete(path); persist();
    }));
    conflictPanels.set(path, resolve); conflictHost.append(resolve); schedulePersist();
  }
  function refreshConflict(path: string): void {
    const buffer = buffers.get(path); const remote = conflicts.get(path);
    if (!buffer || !remote) return;
    const compare = el('div', 'editor-comparison');
    for (const [label, text] of [[t('editorUI.base'), buffer.document.text], [t('editorUI.local'), buffer.text], [t('editorUI.remote'), remote.text]]) { const preview = area(text); preview.readOnly = true; preview.setAttribute('aria-label', label!); compare.append(preview); }
    const banner = el('div', 'editor-conflict');
    const adopt = (document: EditorDocument, text: string, expected?: string) => {
      views.forEach((_, index) => capture(index));
      if (disposed || (expected !== undefined && buffer.text !== expected)) throw new UserError(t('detail.editor_conflict'));
      buffer.document = document; buffer.text = text;
      conflicts.delete(path); for (const view of views) if (view.path === path) { view.content.value = text; view.preview.update(text); }
      banner.remove(); persist(); refreshTabs();
    };
    banner.append(el('p', 'warning', `${path}: ${t('editorUI.external')}`), compare,
      button(t('editorUI.adopt'), async () => { if (!await confirmModal(t('editorUI.adopt'), t('editor.dirty'), t('editorUI.adopt'))) return; views.forEach((_, index) => capture(index)); const local = buffer.text; const latest = await request<EditorDocument>(query('/api/editor/file', { ...ids, path })); unresolved.delete(path); adopt(latest, latest.text, local); }),
      button(t('editorUI.keep'), async () => { if (!await confirmModal(t('editorUI.keep'), t('editorUI.unresolved'), t('editorUI.keep'))) return; const latest = await request<EditorDocument>(query('/api/editor/file', { ...ids, path })); views.forEach((_, index) => capture(index)); unresolved.delete(path); adopt(latest, buffer.text); }),
      button(t('editorUI.merge'), async () => {
        views.forEach((_, index) => capture(index)); const local = buffer.text; const base = buffer.document.text;
        const result = await request<{ text: string; revision: string; conflicts: boolean }>('/api/editor/merge', { ...ids, path, base, local, revision: remote.revision });
        views.forEach((_, index) => capture(index)); if (buffer.text !== local || buffer.document.text !== base) throw new UserError(t('detail.editor_conflict'));
        adopt({ ...remote, revision: result.revision }, result.text);
        if (result.conflicts) markUnresolved(path);
      }));
    conflictPanels.get(path)?.remove(); conflictPanels.set(path, banner); conflictHost.append(banner);
  }
  let syncing = false;
  async function synchronize(): Promise<void> {
    if (syncing || disposed || editReserved || !persistenceEnabled || dialog.hidden || !buffers.size) return;
    syncing = true;
    try {
      views.forEach((_, index) => capture(index));
      const revisions = new Map([...buffers.values()].map(buffer => [buffer.document.path, buffer.document.revision]));
      const result = await request<{ changes: { path: string; status: string }[] }>('/api/editor/revisions', { ...ids, documents: [...buffers.values()].map(buffer => ({ path: buffer.document.path, revision: buffer.document.revision })) });
      for (const change of result.changes) {
        if (change.status === 'unchanged') continue;
        const buffer = buffers.get(change.path); if (!buffer) continue;
        if (change.status === 'missing') { buffer.document = { ...buffer.document, readonly: true }; for (const view of views) if (view.path === change.path) view.content.readOnly = true; continue; }
        const remote = await request<EditorDocument>(query('/api/editor/file', { ...ids, path: change.path }));
        views.forEach((_, index) => capture(index));
        if (disposed || buffer.document.revision !== revisions.get(change.path)) continue;
        if (dirty(buffer)) { conflicts.set(change.path, remote); refreshConflict(change.path); }
        else { buffer.document = remote; buffer.text = remote.text; for (const view of views) if (view.path === change.path) { view.content.value = remote.text; view.preview.update(remote.text); } }
      }
      persist(); refreshTabs();
    } finally { syncing = false; }
  }
  const syncTimer = window.setInterval(() => { void run(synchronize); }, 5000);
  const syncFocus = () => { void run(synchronize); }; window.addEventListener('focus', syncFocus);
  const dirty = (buffer: EditorRecovery) => buffer.text.replace(/\r\n/g, '\n') !== buffer.document.text.replace(/\r\n/g, '\n') || (buffer.encoding ?? buffer.document.encoding ?? 'UTF8') !== (buffer.document.encoding ?? 'UTF8');
  let persistenceTimer: number | undefined;
  const live = new Map<string, { timer?: number; flight?: Promise<void>; disabled: boolean; text?: string; diagnostics: EditorDiagnostic[] }>();
  let disposed = false;
  let debugState: { breakpoints: { path: string; line: number }[]; active?: { path: string; line: number } } = { breakpoints: [] };
  const renderDebug = () => {
    const active = debugState.active;
    for (const view of views) view.content.debugDecoration(debugState.breakpoints.filter(bp => bp.path === view.path).map(bp => bp.line), active && active.path === view.path ? active.line : undefined);
  };
  const debugDecoration = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail || detail.project !== project || detail.task !== task || !Array.isArray(detail.breakpoints)) return;
    debugState = { breakpoints: detail.breakpoints, ...(detail.active ? { active: detail.active } : {}) }; renderDebug();
  };
  window.addEventListener('yumeewade:debug-decoration', debugDecoration);
  const proposalRanges = new Map<string, { from: number; to: number; state: string; text?: string }[]>();
  const renderProposals = (path: string) => { for (const view of views) if (view.path === path) view.content.proposalDecoration(pendingProposalRanges(proposalRanges.get(path) ?? [])); };
  const proposalDecoration = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail || detail.project !== project || detail.task !== task || typeof detail.path !== 'string') return;
    if (Array.isArray(detail.edits)) proposalRanges.set(detail.path, detail.edits.filter((edit: { from: number; to: number; state: string }) => edit && Number.isSafeInteger(edit.from) && Number.isSafeInteger(edit.to) && edit.from >= 0 && edit.to >= edit.from && typeof edit.state === 'string').slice(0, 500));
    else if (event.type === 'yumeewade:proposal-decision') proposalRanges.set(detail.path, (proposalRanges.get(detail.path) ?? []).filter(edit => edit.from !== detail.from || edit.to !== detail.to));
    renderProposals(detail.path);
  };
  dialog.addEventListener('yumeewade:proposal-generated', proposalDecoration);
  dialog.addEventListener('yumeewade:proposal-decision', proposalDecoration);
  function renderDiagnostics(path: string): void {
    const items = live.get(path)?.diagnostics ?? [];
    for (const view of views) if (view.path === path) {
      const doc = view.content.view.state.doc;
      const offset = (line: number, character: number) => { const row = doc.line(Math.min(doc.lines, line + 1)); return row.from + Math.min(row.length, character); };
      view.content.diagnostics(items.map(item => {
        const from = offset(item.line, item.character);
        return { from, to: Math.max(from, item.endLine === undefined ? Math.min(doc.length, from + 1) : offset(item.endLine, item.endCharacter ?? item.character)), severity: item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : 'info', message: item.message };
      }));
    }
  }
  function scheduleDiagnostics(path: string): void {
    const buffer = buffers.get(path);
    if (disposed || !buffer?.document.languageAvailable || buffer.document.binary || buffer.document.truncated) return;
    let state = live.get(path);
    if (!state) { state = { disabled: false, diagnostics: [] }; live.set(path, state); }
    if (state.disabled || state.text === buffer.text) return;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      if (state.flight) return;
      const text = buffers.get(path)?.text; if (text === undefined || disposed) return;
      if (new TextEncoder().encode(JSON.stringify(text)).byteLength > 2_097_152 - 8192 || text.includes('\0')) { state.diagnostics = []; renderDiagnostics(path); refreshTabs(); return; }
      state.text = text;
      state.flight = (async () => {
        try {
          const result = await request<EditorActionResult>('/api/editor/language', { ...ids, path, text, line: 0, character: 0, action: 'diagnostics' });
          if (!disposed && live.get(path) === state && buffers.get(path)?.text === text) { state.diagnostics = result.diagnostics; renderDiagnostics(path); refreshTabs(); }
        } catch { state.disabled = true; state.diagnostics = []; if (!disposed) { renderDiagnostics(path); refreshTabs(); } }
        finally { delete state.flight; if (live.get(path) === state) scheduleDiagnostics(path); }
      })();
    }, 400);
  }
  async function closeDiagnostics(path: string): Promise<void> {
    const state = live.get(path); if (!state) return;
    live.delete(path); window.clearTimeout(state.timer); await state.flight;
    await request('/api/editor/language', { ...ids, path, action: 'close' }).catch(() => undefined);
  }
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
      const state = { version: 4, buffers: recovery, unresolved: [...unresolved], split: Number(views[0]?.node.style.flex) || 50, panes: views.map((view, index) => ({ tabs: paneTabs[index], navigation: navigation[index], path: view.path ?? null, start: view.content.selectionStart, end: view.content.selectionEnd, top: view.content.scrollTop, left: view.content.scrollLeft })), focused };
      let data = JSON.stringify(state); let omitted = false;
      while (new TextEncoder().encode(data).byteLength > 4 * 1024 * 1024 && recovery.length && 'clean' in recovery.at(-1)!) {
        recovery.pop(); omitted = true; data = JSON.stringify(state);
      }
      if (new TextEncoder().encode(data).byteLength > 4 * 1024 * 1024) throw new UserError(t('ew.recoveryLimit'));
      if (omitted) output.append(el('p', 'warning', t('ew.recoveryLimit')));
      localStorage.setItem(storageKey, data);
    } catch { output.replaceChildren(el('p', 'warning', t('ew.recoveryLimit'))); toast(t('ew.recoveryLimit')); }
  }
  function capture(index: number): void { const view = views[index]!; const buffer = view.path ? buffers.get(view.path) : undefined; if (buffer && !isImage(buffer.document.path)) { buffer.text = view.content.value; buffer.start = view.content.selectionStart; buffer.end = view.content.selectionEnd; buffer.top = view.content.scrollTop; buffer.left = view.content.scrollLeft; } }
  type Position = { path: string; start: number; end: number; top: number; left: number };
  const navigation: { entries: Position[]; cursor: number }[] = [];
  const paneTabs: { path: string; pinned: boolean; preview: boolean }[][] = [];
  let replaying = false;
  function position(index: number): Position | undefined { const view = views[index]!; return view.path ? { path: view.path, start: view.content.selectionStart, end: view.content.selectionEnd, top: view.content.scrollTop, left: view.content.scrollLeft } : undefined; }
  function recordPosition(index: number): void {
    const entry = position(index); const history = navigation[index]; if (!entry || !history || replaying) return;
    const previous = history.entries[history.cursor];
    if (previous && previous.path === entry.path && previous.start === entry.start && previous.end === entry.end) { history.entries[history.cursor] = entry; return; }
    history.entries.splice(history.cursor + 1); history.entries.push(entry);
    if (history.entries.length > 200) history.entries.shift();
    history.cursor = history.entries.length - 1;
  }
  async function navigatePosition(delta: number): Promise<void> {
    if (editReserved) return;
    const index = focused; const history = navigation[index]!; const target = history.cursor + delta; const entry = history.entries[target]; if (!entry) return;
    const currentPosition = position(index); if (currentPosition && history.cursor >= 0) history.entries[history.cursor] = currentPosition;
    replaying = true;
    try { await show(entry.path); if (disposed) return; activate(entry.path, index); const content = views[index]!.content; content.setSelectionRange(entry.start, entry.end); content.scrollTop = entry.top; content.scrollLeft = entry.left; history.cursor = target; capture(index); schedulePersist(); } finally { replaying = false; }
  }
  async function closeTabs(index: number, paths: string[]): Promise<void> {
    if (editReserved) return;
    views.forEach((_, i) => capture(i));
    const dropping = paths.filter(path => !paneTabs.some((tabs, i) => i !== index && tabs.some(tab => tab.path === path)));
    const dirtyPaths = dropping.filter(path => { const buffer = buffers.get(path); return buffer && dirty(buffer); });
    if (dirtyPaths.length && !await confirmModal(t('editor.dirty'), dirtyPaths.join('\n'), t('editor.discard'))) return;
    if (editReserved) return;
    paneTabs[index] = paneTabs[index]!.filter(tab => !paths.includes(tab.path));
    for (const path of dropping) { buffers.delete(path); await closeDiagnostics(path); views.forEach(view => view.content.forget(path)); }
    const view = views[index]!;
    if (view.path && paths.includes(view.path)) { view.path = undefined; view.content.value = ''; view.content.readOnly = true; view.preview.clear(); const next = paneTabs[index]!.at(-1); if (next) activate(next.path, index); }
    persist(); refreshTabs();
  }
  function refreshTabs(): void {
    for (const [index, view] of views.entries()) view.tabs.replaceChildren(...paneTabs[index]!.filter(tab => buffers.has(tab.path)).map(tab => {
      const buffer = buffers.get(tab.path)!;
      return row(button(`${tab.pinned ? '● ' : ''}${tab.preview ? '◇ ' : ''}${tab.path}${dirty(buffer) ? ' *' : ''}`, () => activate(tab.path, index)),
        button(t(tab.pinned ? 'editorFront.unpin' : 'editorFront.pin'), () => { if (editReserved) return; tab.pinned = !tab.pinned; tab.preview = false; persist(); refreshTabs(); }),
        button(t('common.close'), () => closeTabs(index, [tab.path])),
        button(t('editorFront.closeOthers'), () => closeTabs(index, paneTabs[index]!.filter(other => other.path !== tab.path && !other.pinned).map(other => other.path))),
        button(t('editorFront.closeRight'), () => closeTabs(index, paneTabs[index]!.slice(paneTabs[index]!.indexOf(tab) + 1).filter(other => !other.pinned).map(other => other.path))));
    }));
  }
  function activate(path: string, index = focused, line?: number, character = 0): void {
    if (editReserved) return;
    capture(index); const buffer = buffers.get(path); if (!buffer) return;
    if (!paneTabs[index]!.some(tab => tab.path === path)) {
      const preview = paneTabs[index]!.find(tab => tab.preview && !tab.pinned);
      if (preview) {
        if (dirty(buffers.get(preview.path)!)) preview.preview = false;
        else { paneTabs[index] = paneTabs[index]!.filter(tab => tab !== preview); if (!paneTabs.some(tabs => tabs.some(tab => tab.path === preview.path))) { buffers.delete(preview.path); void closeDiagnostics(preview.path); } }
      }
      paneTabs[index]!.push({ path, pinned: false, preview: true });
    }
    recordPosition(index);
    const wasReplaying = replaying; replaying = true;
    const view = views[index]!; view.path = path; view.content.open(path, buffer.text); view.content.readOnly = isImage(path) || buffer.document.readonly || buffer.document.binary || buffer.document.truncated;
    view.content.resolvedFormat(formats.get(path));
    view.preview.open(path, buffer.text, buffer.document.size);
    if (line === undefined) {
      view.content.setSelectionRange(buffer.start, buffer.end); view.content.scrollTop = buffer.top; view.content.scrollLeft = buffer.left;
    } else view.content.revealLine(line + 1, character);
    if (!isImage(path)) view.content.focus(); focused = index; refreshTabs();
    encoding.value = buffer.encoding ?? buffer.document.encoding ?? 'UTF8';
    encoding.disabled = view.content.readOnly;
    capture(index); schedulePersist();
    replaying = wasReplaying;
    recordPosition(index);
    renderDebug();
    renderProposals(path);
    window.dispatchEvent(new CustomEvent('yumeewade:editor-active', { detail: { project, task, path, content: view.content } }));
    if (!isImage(path)) { renderDiagnostics(path); scheduleDiagnostics(path); }
    if (view.content.readOnly && !isImage(path)) output.replaceChildren(el('p', 'warning', buffer.document.binary ? t('files.binary') : buffer.document.truncated ? t('files.truncated') : t('detail.editor_readonly')));
  }
  let openSerial = 0;
  async function show(path: string, line?: number, character = 0): Promise<void> {
    const serial = ++openSerial; const index = focused;
    if (!buffers.has(path)) {
      if (buffers.size >= 50) throw new UserError(t('ew.recoveryLimit'));
      const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path }));
      const format = await request<EditorResolvedFormatPreferences>(query('/api/editor/preferences', { ...ids, path }));
      if (!disposed) formats.set(path, format);
      if (!dialog.isConnected) return;
      if (!buffers.has(path)) buffers.set(path, { document, text: document.text, start: 0, end: 0, top: 0, left: 0 });
    }
    if (serial === openSerial && dialog.isConnected) activate(path, index, line, character);
  }
  function pane(): void {
    const index = views.length; const code = el('div', 'editor-code'); const content = new EditorContent(code, t('editor.content'));
    paneTabs.push([]);
    const tabs = el('div'); const node = el('div'); const body = el('div'); const preview = new FilePreview(code, ids); body.append(code, preview.node); node.style.minWidth = '0'; node.style.flex = '1'; node.append(tabs, body); views.push({ path: undefined, content, preview, tabs, node }); panes.append(node);
    navigation.push({ entries: [], cursor: -1 });
    node.prepend(row(button(t('editorFront.back'), () => { focused = index; return navigatePosition(-1); }), button(t('editorFront.forward'), () => { focused = index; return navigatePosition(1); })));
    schedulePersist();
    content.ongutter = line => { const path = views[index]!.path; if (path) window.dispatchEvent(new CustomEvent('yumeewade:debug-gutter', { detail: { project, task, path, line } })); };
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
    content.onfocus = () => { focused = index; const buffer = views[index]!.path ? buffers.get(views[index]!.path!) : undefined; encoding.value = buffer?.encoding ?? buffer?.document.encoding ?? 'UTF8'; encoding.disabled = content.readOnly; schedulePersist(); };
    content.oninput = () => {
      capture(index); const path = views[index]!.path;
      if (path) for (const tabs of paneTabs) for (const tab of tabs) if (tab.path === path) tab.preview = false;
      for (let other = 0; other < views.length; other++) if (other !== index && views[other]!.path === path && path) {
        const sibling = views[other]!; const start = sibling.content.selectionStart; const end = sibling.content.selectionEnd; const top = sibling.content.scrollTop; const left = sibling.content.scrollLeft;
        sibling.content.value = content.value; sibling.content.setSelectionRange(start, end); sibling.content.scrollTop = top; sibling.content.scrollLeft = left;
        sibling.preview.update(content.value);
      }
      views[index]!.preview.update(content.value);
      schedulePersist(); refreshTabs();
      if (path) { const state = live.get(path); if (state) state.diagnostics = []; renderDiagnostics(path); refreshTabs(); scheduleDiagnostics(path); }
    };
    content.onscroll = () => { capture(index); schedulePersist(); };
    content.onselect = () => { capture(index); schedulePersist(); if (!replaying) recordPosition(index); };
    content.onkeydown = event => {
      const command = preferenceCommand(event, readPreferences());
      if (command === 'selection' && task) { event.preventDefault(); sendSelection(); }
      else if (command === 'save') { event.preventDefault(); void run(save); }
    };
  }
  function current(): EditorRecovery | undefined { capture(focused); const path = views[focused]!.path; return path ? buffers.get(path) : undefined; }
  async function save(): Promise<void> {
    if (editReserved) throw new UserError(t('detail.editor_conflict'));
    if (readPreferences().formatOnSave) await formatBeforeSave();
    pendingWrites++;
    try {
      const buffer = current(); if (!buffer || buffer.document.readonly || buffer.document.binary || buffer.document.truncated) return;
      const selectedEncoding = buffer.encoding ?? buffer.document.encoding ?? 'UTF8';
      if (!dirty(buffer) && selectedEncoding === (buffer.document.encoding ?? 'UTF8')) return;
      if (conflicts.has(buffer.document.path) || unresolved.has(buffer.document.path)) throw new UserError(t('editorUI.unresolved'));
      const local = buffer.text; const format = await request<EditorResolvedFormatPreferences>(query('/api/editor/preferences', { ...ids, path: buffer.document.path }));
      const text = serializeEol(local, format.source === 'default' ? readPreferences().eol : format.eol, buffer.document.text);
      buffer.document = await request<EditorDocument>('/api/editor/save', { ...ids, path: buffer.document.path, text, revision: buffer.document.revision, encoding: selectedEncoding });
      if (buffer.encoding === selectedEncoding) delete buffer.encoding;
      views.forEach((_, index) => capture(index));
      if (buffer.text === local) { buffer.text = text; for (const view of views) if (view.path === buffer.document.path) view.content.value = text; }
      persist(); refreshTabs();
    } finally { pendingWrites--; }
  }
  /** Formats the focused dirty draft through the LSP; any failure only warns and the draft is saved as typed. */
  async function formatBeforeSave(): Promise<void> {
    const buffer = current();
    if (!buffer || !dirty(buffer) || !buffer.document.languageAvailable || buffer.document.readonly || buffer.document.binary || buffer.document.truncated) return;
    const { path, revision } = buffer.document; const text = buffer.text;
    try {
      const result = await request<EditorActionResult>('/api/editor/language', { ...ids, path, revision, text, buffers: editor.snapshots().map(snapshot => ({ path: snapshot.path, revision: snapshot.revision, text: snapshot.text })), line: 0, character: 0, action: 'format', newName: '' });
      const formatted = result.changes?.find(change => change.path === path)?.text;
      if (formatted === undefined || formatted === text) return;
      const expected = { path, revision, text };
      // If the draft changed while the server formatted, keep what the user typed.
      const release = editor.reserveAll([expected]); if (!release) return;
      try { editor.applyEditsAll([{ expected, edits: [{ from: 0, to: text.length, text: formatted }] }]); } finally { release(); }
    } catch (error) { toast(t('editorUI.formatFailed', { reason: errorMessage(error) })); }
  }
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
    if (document.revision !== revision) throw new UserError(t('detail.editor_conflict'));
    const context = await request<TaskContext>(query('/api/task/context', ids));
    if (!context.sources.some(source => source.path === path && source.start === start && source.end === end)) context.sources.push({ path, start, end });
    const checked = await request<EditorDocument>(query('/api/editor/file', { ...ids, path }));
    if (checked.revision !== revision) throw new UserError(t('detail.editor_conflict'));
    await request('/api/task/context', { ...ids, context });
  }
  async function apply(changes: EditorChange[]): Promise<void> {
    views.forEach((_, index) => capture(index));
    const expected: { path: string; revision: string; text: string }[] = [];
    for (const change of changes) {
      if (!buffers.has(change.path)) {
        const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path: change.path }));
        buffers.set(change.path, { document, text: document.text, start: 0, end: 0, top: 0, left: 0 });
      }
      const buffer = buffers.get(change.path)!;
      const base = (change as EditorChange & { baseText?: string }).baseText ?? buffer.document.text;
      if (buffer.document.revision !== change.revision || buffer.text !== base) throw new UserError(t('detail.editor_conflict'));
      expected.push({ path: change.path, revision: change.revision, text: base });
    }
    const preview = area(changes.map(change => `${change.path}\n${buffers.get(change.path)!.text}\n→\n${change.text}`).join('\n\n')); preview.readOnly = true;
    output.replaceChildren(preview, button(t('ew.apply'), async () => {
      if (!(await confirmModal(t('ew.apply'), t('ew.confirm'), t('ew.apply')))) return;
      const release = editor.reserveAll(expected);
      if (!release) throw new UserError(t('detail.editor_conflict'));
      try {
        if (!editor.applyEditsAll(changes.map((change, index) => ({ expected: expected[index]!, edits: [{ from: 0, to: expected[index]!.text.length, text: change.text }] })))) throw new UserError(t('detail.editor_conflict'));
        output.replaceChildren(); persist(); refreshTabs();
      } finally { release(); }
    }));
  }
  async function localHistory(): Promise<void> {
    const buffer = current(); if (!buffer || editReserved) return;
    const path = buffer.document.path;
    const result = await request<{ entries: { id: string; path: string; revision: string; text: string; timestamp: string; reason: string }[] }>(query('/api/editor/history', { ...ids, path }));
    output.replaceChildren(...result.entries.map(entry => button(`${entry.timestamp} · ${entry.revision.slice(0, 8)}`, () => {
      views.forEach((_, index) => capture(index));
      const expected = { path, revision: buffer.document.revision, text: buffer.text };
      const before = area(entry.text); before.readOnly = true; before.setAttribute('aria-label', t('editorUI.base'));
      const after = area(buffer.text); after.readOnly = true; after.setAttribute('aria-label', t('editorUI.local'));
      output.replaceChildren(row(before, after), button(t('editorFront.restore'), async () => {
        if (!await confirmModal(t('editorFront.restore'), dirty(buffer) ? t('editor.dirty') : t('ew.confirm'), t('editorFront.restore'))) return;
        const release = editor.reserveAll([expected]); if (!release) throw new UserError(t('detail.editor_conflict'));
        pendingWrites++;
        try {
          const document = await request<EditorDocument>('/api/editor/history/restore', { ...ids, path, id: entry.id, revision: expected.revision });
          buffer.document = document; buffer.text = document.text;
          for (const view of views) if (view.path === path) { view.content.value = document.text; view.preview.update(document.text); }
          persist(); refreshTabs(); output.replaceChildren();
        } finally { pendingWrites--; release(); }
      }));
    })));
  }
  const newName = input('', t('ew.newName'));
  async function language(action: EditorAction): Promise<void> {
    const buffer = current(); if (!buffer) return; const snapshot = buffer.text; const start = buffer.start; const end = buffer.end; const before = snapshot.slice(0, start).split('\n');
    views.forEach((_, index) => capture(index));
    const result = await request<EditorActionResult>('/api/editor/language', { ...ids, path: buffer.document.path, revision: buffer.document.revision, text: buffer.text, buffers: editor.snapshots().map(({ path, revision, text }) => ({ path, revision, text })), line: before.length - 1, character: before.at(-1)!.length, action, newName: newName.value });
    output.replaceChildren(...result.locations.map(location => button(`${location.path}:${location.line + 1}`, () => show(location.path, location.line, location.character))), ...result.diagnostics.map(item => button(`${item.line + 1} ${item.message}`, () => show(buffer.document.path, item.line, item.character))));
    renderAdvancedLanguage(output, result, buffer.document.path, show);
    if (buffer.text === snapshot && result.inlayHints) for (const view of views) if (view.path === buffer.document.path) view.content.inlayHints(result.inlayHints);
    for (const symbol of result.symbols ?? []) output.append(button(`${symbol.container ? `${symbol.container} · ` : ''}${symbol.name} · ${symbol.path}:${symbol.line + 1}`, () => show(symbol.path, symbol.line, symbol.character)));
    if (result.hover) output.append(el('pre', '', result.hover));
    for (const suggestion of result.suggestions ?? []) output.append(button(`${suggestion.label} ${suggestion.detail ?? ''}`, () => {
      if (editReserved || buffer.text !== snapshot) throw new UserError(t('detail.editor_conflict'));
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
    results.replaceChildren(...[...fileHierarchy(found.files)].map(([folder, paths]) => {
      const group = el('details'); group.open = !folder || !!q;
      group.append(el('summary', '', folder || project), ...paths.map(path => button(path.slice(path.lastIndexOf('/') + 1), () => show(path), 'file-result')));
      return group;
    }));
    if (found.total > found.files.length) results.append(el('p', 'muted', t('files.more', { total: found.total, n: found.files.length })));
  }
  async function search(replace: boolean): Promise<void> {
    const needle = sourceSearch.value; const serial = ++searchSerial;
    // Empty scope fields mean "no filter"; the API rejects empty strings rather than treating them as a wildcard.
    const options = { caseSensitive: String(caseSensitive.checked), wholeWord: String(wholeWord.checked), regex: String(regex.checked), ...(include.value.trim() ? { include: include.value } : {}), ...(exclude.value.trim() ? { exclude: exclude.value } : {}), mode: mode.value, page: String(searchPage), pageSize: '100' };
    const found = await request<EditorSearchResult & { total: number; page: number; pageSize: number; truncated: boolean }>(query('/api/editor/search', { ...ids, q: needle, ...options }));
    if (serial !== searchSerial) return;
    output.replaceChildren(...found.hits.map(hit => row(button(`${hit.path}:${hit.line + 1} ${hit.preview}`, () => show(hit.path, hit.line, hit.character)), ...(task ? [button(t('ew.pin'), () => pin(hit.path, hit.line + 1, hit.line + Math.max(1, needle.split('\n').length), hit.revision))] : []))));
    const previous = button(t('editorFront.previous'), () => { searchPage--; return search(false); }); previous.disabled = found.page <= 1;
    const next = button(t('editorFront.next'), () => { searchPage++; return search(false); }); next.disabled = found.page * found.pageSize >= found.total;
    output.append(row(previous, el('span', '', `${found.page} · ${found.total}`), next));
    if (found.truncated) output.append(el('p', 'warning', t('files.more', { total: found.total, n: found.hits.length })));
    if (replace) {
      if (mode.value !== 'content') return;
      const pattern = regex.checked ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const expression = new RegExp(wholeWord.checked ? `\\b(?:${pattern})\\b` : pattern, caseSensitive.checked ? 'g' : 'gi');
      const changes: EditorChange[] = [];
      for (const path of new Set(found.hits.map(hit => hit.path))) {
        const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path }));
        if (found.hits.some(hit => hit.path === path && hit.revision !== document.revision)) throw new UserError(t('detail.editor_conflict'));
        const text = buffers.get(path)?.text ?? document.text;
        changes.push({ path, revision: document.revision, baseText: text, text: text.replace(expression, replacement.value) });
      }
      if (changes.length) await apply(changes);
    }
  }
  const pathInput = input('', t('ew.path')); const destination = input('', t('ew.destination'));
  async function mutate(action: EditorMutation['action']): Promise<void> {
    if (editReserved) throw new UserError(t('detail.editor_conflict'));
    const path = pathInput.value; const mutation: EditorMutation = { action, path, destination: destination.value };
    if (action === 'delete' || action === 'rename') {
      if ([...buffers.values()].some(buffer => dirty(buffer) && (buffer.document.path === path || buffer.document.path.startsWith(`${path}/`)))) throw new UserError(t('ew.saveFirst'));
      mutation.confirmation = path;
      try { mutation.revision = (await request<EditorDocument>(query('/api/editor/file', { ...ids, path }))).revision; }
      catch { mutation.revision = (await request<{ revision: string }>(query('/api/editor/folder', { ...ids, path }))).revision; }
      if (!(await confirmModal(`${t('ew.confirm')} ${path}`, path, t(`ew.${action}`)))) return;
    }
    if (action === 'delete' || action === 'rename') for (const key of buffers.keys()) if (key === path || key.startsWith(`${path}/`)) await closeDiagnostics(key);
    if (editReserved) throw new UserError(t('detail.editor_conflict'));
    pendingWrites++;
    try {
      await request('/api/editor/mutate', { ...ids, ...mutation });
      if (action === 'delete' || action === 'rename') {
        for (const key of buffers.keys()) if (key === path || key.startsWith(`${path}/`)) { buffers.delete(key); views.forEach(view => view.content.forget(key)); }
        for (const view of views) if (view.path && (view.path === path || view.path.startsWith(`${path}/`))) { view.path = undefined; view.content.value = ''; view.content.readOnly = true; view.preview.clear(); }
        persist(); refreshTabs();
      }
      await load();
    } finally { pendingWrites--; }
  }
  async function recover(): Promise<void> {
    let raw: string | null;
    try { raw = localStorage.getItem(storageKey); }
    catch { output.append(el('p', 'warning', t('ew.recoveryLimit'))); return; }
    if (!raw) return;
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { output.append(el('p', 'warning', t('ew.recoveryLimit'))); return; }
    const session = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as { version?: unknown; buffers?: unknown; panes?: unknown; focused?: unknown; unresolved?: unknown; split?: unknown } : undefined;
    const values = Array.isArray(parsed) ? parsed : session?.version === 3 || session?.version === 4 ? session.buffers : undefined;
    if (!Array.isArray(values) || values.length > 50 || new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024) { output.append(el('p', 'warning', t('ew.recoveryLimit'))); return; }
    if (values.some(value => value && typeof value === 'object' && !('clean' in value && value.clean === true)) && !(await confirmModal(t('ew.recover'), t('ew.recover'), t('ew.recover')))) throw new UserError(t('ew.recover'));
    for (const value of values) { if (!value || typeof value !== 'object') continue; const candidate = value as Partial<EditorRecovery> & { clean?: boolean }; if (!candidate.document || typeof candidate.document.path !== 'string' || typeof candidate.document.revision !== 'string' || typeof candidate.text !== 'string' || candidate.text.length > 4 * 1024 * 1024) continue;
      const original = candidate.document;
      if (typeof original.text !== 'string') continue;
      const recovered: EditorRecovery = { document: original, text: candidate.text, ...(['UTF8', 'UTF8-BOM', 'UTF16LE', 'UTF16BE'].includes(candidate.encoding ?? '') ? { encoding: candidate.encoding } : {}), start: Number.isSafeInteger(candidate.start) ? candidate.start! : 0, end: Number.isSafeInteger(candidate.end) ? candidate.end! : 0, top: typeof candidate.top === 'number' ? candidate.top : 0, left: typeof candidate.left === 'number' ? candidate.left : 0 };
      buffers.set(original.path, recovered);
      try {
        const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path: original.path }));
        const conflict = !candidate.clean && document.revision !== original.revision;
        recovered.document = conflict ? { ...document, text: original.text, revision: original.revision, encoding: original.encoding ?? 'UTF8' } : document;
        if (candidate.clean) recovered.text = document.text;
        if (conflict) { conflicts.set(document.path, document); refreshConflict(document.path); }
        formats.set(document.path, await request<EditorResolvedFormatPreferences>(query('/api/editor/preferences', { ...ids, path: document.path })));
      } catch { recovered.document = { ...original, readonly: true }; output.append(el('p', 'warning', `${original.path}: ${t('ew.recoveryConflict')}`)); }
    }
    refreshTabs();
    if (Array.isArray(session?.unresolved)) for (const path of session.unresolved.slice(0, 50)) if (typeof path === 'string' && buffers.has(path)) markUnresolved(path);
    const savedPanes = (session?.version === 3 || session?.version === 4) && Array.isArray(session.panes) && session.panes.length > 0 && session.panes.length <= 2 ? session.panes : [];
    while (views.length < savedPanes.length) pane();
    if (views.length === 2 && typeof session?.split === 'number' && session.split >= 20 && session.split <= 80) { views[0]!.node.style.flex = String(session.split); views[1]!.node.style.flex = String(100 - session.split); }
    for (let index = 0; index < savedPanes.length; index++) {
      const saved = savedPanes[index] as { tabs?: unknown; navigation?: { entries?: unknown; cursor?: unknown }; path?: unknown; start?: unknown; end?: unknown; top?: unknown; left?: unknown };
      paneTabs[index] = Array.isArray(saved?.tabs) ? saved.tabs.flatMap(tab => tab && typeof tab === 'object' && typeof tab.path === 'string' && buffers.has(tab.path) ? [{ path: tab.path, pinned: tab.pinned === true, preview: tab.preview === true }] : []) : [...buffers.keys()].map(path => ({ path, pinned: false, preview: false }));
      if (!saved || typeof saved.path !== 'string' || !buffers.has(saved.path)) continue;
      activate(saved.path, index);
      const view = views[index]!;
      const start = typeof saved.start === 'number' && Number.isSafeInteger(saved.start) && saved.start >= 0 ? saved.start : 0;
      const end = typeof saved.end === 'number' && Number.isSafeInteger(saved.end) && saved.end >= start ? saved.end : start;
      view.content.setSelectionRange(start, end);
      view.content.scrollTop = typeof saved.top === 'number' && Number.isFinite(saved.top) && saved.top >= 0 ? saved.top : 0;
      view.content.scrollLeft = typeof saved.left === 'number' && Number.isFinite(saved.left) && saved.left >= 0 ? saved.left : 0;
    }
    if (session?.version === 4) for (let index = 0; index < savedPanes.length; index++) {
      const saved = savedPanes[index] as { navigation?: { entries?: unknown; cursor?: unknown } };
      const entries = saved.navigation?.entries;
      if (!Array.isArray(entries) || entries.length > 200) continue;
      const valid = entries.filter((entry): entry is Position => entry && typeof entry.path === 'string' && buffers.has(entry.path) && ['start', 'end', 'top', 'left'].every(key => typeof entry[key] === 'number' && Number.isFinite(entry[key]) && entry[key] >= 0) && Number.isSafeInteger(entry.start) && Number.isSafeInteger(entry.end) && entry.end >= entry.start);
      const cursor = saved.navigation?.cursor;
      navigation[index] = { entries: valid, cursor: typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= -1 && cursor < valid.length ? cursor : valid.length - 1 };
    }
    if (savedPanes.length) {
      focused = typeof session?.focused === 'number' && Number.isSafeInteger(session.focused) && session.focused >= 0 && session.focused < views.length ? session.focused : 0;
      views[focused]!.content.focus();
    } else { paneTabs[0] = [...buffers.keys()].map(path => ({ path, pinned: false, preview: false })); const first = buffers.keys().next().value; if (first) activate(first); }
  }
  pane();
  const send = button(t('editorEvents.send'), sendSelection);
  send.disabled = !task; send.title = t(task ? 'editorEvents.shortcut' : 'editorEvents.noTask');
  // Everyday controls stay visible; the rest are grouped so the editor keeps most of the panel height.
  const groupKey = 'yumeewade.workbench.groups';
  const group = (key: string, title: string, ...children: Node[]): HTMLDetailsElement => {
    const node = el('details', 'workbench-group'); node.append(el('summary', '', title), ...children);
    node.open = readLocal<Record<string, boolean>>(groupKey, {})[key] === true;
    node.addEventListener('toggle', () => storeLocal(groupKey, { ...readLocal<Record<string, boolean>>(groupKey, {}), [key]: node.open }));
    return node;
  };
  const codeTools = row(...(['definition', 'references', 'diagnostics', 'completion', 'hover', 'rename', 'format', 'codeActions'] as const).map(action => button(t(action === 'definition' || action === 'references' || action === 'diagnostics' ? `editor.${action}` : `ew.${action}`), () => language(action))), newName,
    button(t('ew.problems'), async () => { const problems = await request<EditorProblem[]>(query('/api/editor/problems', ids)); output.replaceChildren(...problems.map(problem => button(`${problem.path}:${problem.line + 1} ${problem.message}`, () => show(problem.path, problem.line, problem.character)))); }), ...(task ? [button(t('ew.pin'), async () => {
      const buffer = current(); if (!buffer) return;
      if (dirty(buffer)) throw new UserError(t('ew.saveFirst'));
      await pin(buffer.document.path, buffer.text.slice(0, buffer.start).split('\n').length, buffer.text.slice(0, buffer.end).split('\n').length, buffer.document.revision);
    })] : []));
  codeTools.append(button(t('editorUI.outline'), () => language('documentSymbols')), button(t('editorUI.symbols'), () => language('workspaceSymbols')));
  codeTools.append(button(t('editorFront.history'), localHistory));
  codeTools.append(...(['signatureHelp', 'implementation', 'inlayHints', 'callHierarchy'] as const).map(action => button(t(`editorFront.${action}`), () => language(action))));
  const actions = row(button(t('common.save'), save), button(t('ew.split'), () => { if (views.length < 2) { capture(focused); const path = views[focused]!.path; pane(); if (path) activate(path, 1); refreshTabs(); } }), send);
  encoding.onchange = () => {
    const buffer = current(); if (!buffer || views[focused]!.content.readOnly || editReserved) return;
    buffer.encoding = encoding.value as NonNullable<EditorRecovery['encoding']>;
    for (const tabs of paneTabs) for (const tab of tabs) if (tab.path === buffer.document.path) tab.preview = false;
    persist(); refreshTabs();
  };
  actions.append(encoding,
    group('code', t('ew.groupCode'), codeTools),
    group('files', t('ew.groupFiles'), row(pathInput, destination, ...(['createFile', 'createFolder', 'rename', 'delete'] as const).map(action => button(t(`ew.${action}`), () => mutate(action))))),
    group('search', t('ew.groupSearch'), searchOptions, row(sourceSearch, replacement, button(t('ew.search'), () => { searchPage = 1; return search(false); }), button(t('ew.replacePreview'), () => { searchPage = 1; return search(true); }))));
  filter.oninput = () => void run(load);
  // Keyboard file picking in the tree filter: Enter opens the best ranked match, arrows walk the results.
  // (Ctrl/⌘+P stays the global go-to-file picker.)
  filter.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const first = results.querySelector<HTMLButtonElement>('.file-result');
    if (event.key === 'Enter' && first) { event.preventDefault(); first.click(); }
    else if (event.key === 'ArrowDown' && first) { event.preventDefault(); first.focus(); }
  });
  results.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...results.querySelectorAll<HTMLButtonElement>('.file-result')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && at === 0) filter.focus();
    else items[Math.min(items.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]!.focus();
  });
  const unload = (event: BeforeUnloadEvent) => { views.forEach((_, index) => capture(index)); persist(); if (editReserved || [...buffers.values()].some(dirty)) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  const panelHost = el('div', 'editor-extension-panels');
  const editor: WorkbenchEditorHost = {
    reserveSegment: path => {
      views.forEach((_, index) => capture(index));
      const buffer = buffers.get(path);
      if (disposed || editReserved || pendingWrites || syncing || buffer && !buffer.document.readonly && !buffer.document.truncated && dirty(buffer)) return null;
      editReserved = true; pendingWrites++; dialog.inert = true;
      let released = false;
      return () => { if (released) return; released = true; editReserved = false; pendingWrites--; dialog.inert = false; if (disposeDeferred) dispose(); };
    },
    refresh: async path => {
      const buffer = buffers.get(path); if (!buffer) return;
      const document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path }));
      views.forEach((_, index) => capture(index));
      if (disposed || buffers.get(path) !== buffer || dirty(buffer)) return;
      buffer.document = document; buffer.text = document.text;
      for (const view of views) if (view.path === path) { view.content.value = document.text; view.preview.update(document.text); view.content.readOnly = document.readonly || document.binary || document.truncated; }
      persist(); refreshTabs();
    },
    snapshot: () => { const buffer = current(); if (!buffer) return null; return { path: buffer.document.path, revision: buffer.document.revision, text: buffer.text, selection: { from: buffer.start, to: buffer.end } }; },
    snapshots: () => { views.forEach((_, index) => capture(index)); return [...buffers.values()].filter(buffer => !buffer.document.readonly && !buffer.document.binary && !buffer.document.truncated && !conflicts.has(buffer.document.path) && !unresolved.has(buffer.document.path)).map(buffer => ({ path: buffer.document.path, revision: buffer.document.revision, text: buffer.text, selection: { from: buffer.start, to: buffer.end } })); },
    reserveAll: expected => {
      views.forEach((_, index) => capture(index));
      if (disposed || editReserved || pendingWrites || syncing || !expected.length || new Set(expected.map(item => item.path)).size !== expected.length || expected.some(item => {
        const buffer = buffers.get(item.path);
        return !buffer || buffer.document.revision !== item.revision || buffer.text !== item.text || buffer.document.readonly || buffer.document.binary || buffer.document.truncated || conflicts.has(item.path) || unresolved.has(item.path);
      })) return null;
      editReserved = true; dialog.inert = true;
      const editable = views.map(view => ({ content: view.content, readonly: view.content.readOnly }));
      for (const view of editable) view.content.readOnly = true;
      let released = false;
      return () => { if (released) return; released = true; editReserved = false; dialog.inert = false; for (const view of editable) view.content.readOnly = view.readonly; if (disposeDeferred) dispose(); };
    },
    applyEditsAll: changes => {
      views.forEach((_, index) => capture(index));
      const plans = changes.map(change => ({ ...change, buffer: buffers.get(change.expected.path), sorted: [...change.edits].sort((a, b) => a.from - b.from) }));
      if (new Set(plans.map(plan => plan.expected.path)).size !== plans.length || plans.some(({ buffer, expected, sorted }) => !buffer || buffer.document.revision !== expected.revision || buffer.text !== expected.text || buffer.document.readonly || buffer.document.binary || buffer.document.truncated || conflicts.has(expected.path) || unresolved.has(expected.path) || sorted.some((edit, index) => !Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > expected.text.length || typeof edit.text !== 'string' || (index > 0 && edit.from < sorted[index - 1]!.to)))) return false;
      for (const { buffer, expected, sorted } of plans) {
        let text = expected.text;
        for (const edit of [...sorted].reverse()) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
        buffer!.text = text;
        for (const view of views) if (view.path === expected.path) { view.content.view.dispatch({ changes: sorted.map(edit => ({ from: edit.from, to: edit.to, insert: edit.text })), annotations: isolateHistory.of('full') }); view.preview.update(text); }
        scheduleDiagnostics(expected.path);
      }
      persist(); refreshTabs(); return true;
    },
    reserve: expected => {
      const buffer = current();
      if (disposed || editReserved || pendingWrites || syncing || !buffer || buffer.document.path !== expected.path || buffer.document.revision !== expected.revision || buffer.text !== expected.text || views[focused]!.content.readOnly || conflicts.has(expected.path) || unresolved.has(expected.path)) return null;
      editReserved = true; dialog.inert = true;
      const editable = views.map(view => ({ content: view.content, readonly: view.content.readOnly }));
      for (const view of editable) view.content.readOnly = true;
      let released = false;
      return () => {
        if (released) return; released = true; editReserved = false; dialog.inert = false;
        for (const view of editable) view.content.readOnly = view.readonly;
        if (disposeDeferred) dispose();
      };
    },
    applyEdits: (expected, edits) => {
      const buffer = current(); if (!buffer || buffer.document.path !== expected.path || buffer.document.revision !== expected.revision || buffer.text !== expected.text || (!editReserved && views[focused]!.content.readOnly)) return false;
      const sorted = [...edits].sort((a, b) => a.from - b.from);
      if (sorted.some((edit, index) => !Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > buffer.text.length || (index > 0 && edit.from < sorted[index - 1]!.to))) return false;
      views[focused]!.content.view.dispatch({ changes: sorted.map(edit => ({ from: edit.from, to: edit.to, insert: edit.text })), annotations: isolateHistory.of('full') }); return true;
    }
  };
  const mountedPanels = new Set<string>();
  const mountPanels = () => { for (const [id, factory] of panelFactories) if (!mountedPanels.has(id)) { mountedPanels.add(id); panelHost.append(factory({ project, task, node: dialog, open: (path, line) => show(path, line === undefined ? undefined : line - 1), editor })); } };
  window.addEventListener('yumeewade:workbench-panels', mountPanels); mountPanels();
  const dock = button(t('editorUI.dock'), () => { layout.dock = layout.dock === 'right' ? 'bottom' : 'right'; applyLayout(); });
  let layout = normalizeLayout(undefined);
  const resize = input(); resize.type = 'range'; resize.min = '20'; resize.max = '80'; resize.value = '50'; resize.setAttribute('aria-label', t('editorUI.resize'));
  resize.oninput = () => { layout.width = Number(resize.value); applyLayout(); };
  const treeResize = input(); treeResize.type = 'range'; treeResize.min = '20'; treeResize.max = '60'; treeResize.value = String(layout.tree); treeResize.setAttribute('aria-label', `${t('files.title')} · ${t('editorUI.resize')}`);
  treeResize.oninput = () => { layout.tree = Number(treeResize.value); applyLayout(); };
  const splitResize = input(); splitResize.type = 'range'; splitResize.min = '20'; splitResize.max = '80'; splitResize.value = '50'; splitResize.setAttribute('aria-label', `${t('ew.split')} · ${t('editorUI.resize')}`);
  splitResize.oninput = () => { if (views.length === 2) { views[0]!.node.style.flex = splitResize.value; views[1]!.node.style.flex = String(100 - Number(splitResize.value)); } schedulePersist(); };
  // The sliders carry no visible label; show the accessible name as a tooltip too.
  for (const slider of [resize, treeResize, splitResize]) slider.title = slider.getAttribute('aria-label')!;
  function applyLayout(): void {
    if (!workbenchMount) return;
    workbenchMount.style.width = layout.dock === 'right' ? `${layout.width}%` : '100%'; workbenchMount.dataset.dock = layout.dock;
    document.body.classList.toggle('workbench-bottom', layout.dock === 'bottom');
    results.style.width = `${layout.tree}%`; treeResize.value = String(layout.tree); resize.value = String(layout.width);
    if (views.length === 2) splitResize.value = views[0]!.node.style.flex || '50';
    try { if (storageKey) localStorage.setItem(`${storageKey}:layout`, JSON.stringify(layout)); } catch { output.append(el('p', 'warning', t('ew.recoveryLimit'))); }
  }
  dialog.append(row(el('h2', '', t('files.title')), dock, resize), actions, filter);
  dialog.prepend(row(treeResize, splitResize));
  dialog.append(conflictHost);
  const body = el('div', 'editor-workbench-body'); body.append(results, panes); dialog.append(body, output, panelHost);
  (workbenchMount ?? document.body).append(dialog);
  const ready = (async () => {
    const { scope } = await request<{ scope: string }>(query('/api/editor/scope', ids));
    if (!dialog.isConnected) return;
    storageKey = `editor-recovery:v2:${scope}`;
    try { layout = normalizeLayout(JSON.parse(localStorage.getItem(`${storageKey}:layout`) ?? 'null')); } catch { layout = normalizeLayout(undefined); }
    resize.value = String(layout.width); applyLayout(); await recover();
    if (!dialog.isConnected) return;
    persistenceEnabled = true;
  })().catch(error => { dispose(); browsers.delete(key); throw error; });
  const flush = () => { views.forEach((_, index) => capture(index)); persist(); };
  const dispose = () => {
    if (editReserved) { disposeDeferred = true; dialog.hidden = true; return; }
    dialog.dispatchEvent(new Event('yumeewade:editor-dispose'));
    flush(); disposed = true; window.clearInterval(syncTimer); window.clearTimeout(persistenceTimer);
    window.removeEventListener('focus', syncFocus); window.removeEventListener('beforeunload', unload);
    window.removeEventListener('yumeewade:workbench-panels', mountPanels); window.removeEventListener('yumeewade:debug-decoration', debugDecoration);
    for (const state of live.values()) window.clearTimeout(state.timer);
    live.clear();
    views.forEach(view => { view.content.destroy(); view.preview.destroy(); }); dialog.remove();
  };
  browsers.set(key, { dialog, flush, dispose, canDispose: () => !editReserved && !pendingWrites && ![...buffers.values()].some(dirty) && !conflicts.size && !unresolved.size && dialog.dispatchEvent(new Event('yumeewade:editor-can-dispose', { cancelable: true })), restoreLayout: applyLayout, open: async (path, line) => { await ready; if (dialog.isConnected) await show(path, line === undefined ? undefined : line - 1); } });
  void run(async () => { await ready; await load(); });
}
