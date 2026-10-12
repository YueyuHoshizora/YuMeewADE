import type { EditorSegment } from '../../shared/types.ts';
import type { WorkbenchPanelContext } from './files.ts';
import { request, query } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, input, area, button, row, confirmModal } from './dom.ts';
type Segment = EditorSegment & { path: string };
export function encodingPicker(): HTMLSelectElement { const picker = el('select'); picker.setAttribute('aria-label', t('editorFront.encoding')); for (const value of ['UTF8', 'UTF8-BOM', 'UTF16LE', 'UTF16BE']) { const option = el('option', '', value); option.value = value; picker.append(option); } return picker; }
export function segmentPanel(context: WorkbenchPanelContext): HTMLElement {
  const ids = { project: context.project, ...(context.task ? { task: context.task } : {}) };
  const node = el('details'); node.append(el('summary', '', t('editorFront.segment')));
  const path = input('', t('ew.path')); const offset = input('0', t('editorFront.offset')); offset.type = 'number'; offset.min = '0'; offset.step = '1';
  const length = input('65536', t('editorFront.length')); length.type = 'number'; length.min = '4'; length.max = '262144'; length.step = '1';
  const text = area(''); text.setAttribute('aria-label', t('editor.content')); text.readOnly = true;
  const status = el('p'); const comparison = el('div', 'editor-comparison'); let segment: Segment | undefined;
  let serial = 0; let pending = false;
  const protectDraft = (event: Event) => { if (pending || segment && text.value !== segment.text) { event.preventDefault(); if (event instanceof BeforeUnloadEvent) event.returnValue = ''; } };
  window.addEventListener('beforeunload', protectDraft);
  context.node.addEventListener('yumeewade:editor-can-dispose', protectDraft);
  context.node.addEventListener('yumeewade:editor-dispose', () => window.removeEventListener('beforeunload', protectDraft), { once: true });
  const patch = button(t('editorFront.patch'), async () => {
    if (pending || !segment || path.value !== segment.path) return;
    const release = context.editor.reserveSegment(segment.path);
    if (!release) throw new Error(t('detail.editor_conflict'));
    const expected = segment; const local = text.value;
    pending = true;
    try {
      const result = await request<Segment>('/api/editor/segment', { ...ids, path: segment.path, offset: segment.offset, end: segment.end, text: local, revision: segment.revision, encoding: segment.encoding });
      if (segment !== expected) return;
      segment = { ...result, path: expected.path };
      if (text.value === local) text.value = result.text;
      offset.value = String(result.offset); status.textContent = `${result.encoding} · ${result.offset}–${result.end} / ${result.size}`; comparison.replaceChildren();
    } catch (error) {
      status.textContent = t('detail.editor_conflict');
      comparison.replaceChildren();
      for (const [label, value] of [[t('editorUI.base'), expected.text], [t('editorUI.local'), text.value]]) {
        const preview = area(value); preview.readOnly = true; preview.setAttribute('aria-label', label!); comparison.append(preview);
      }
      try {
        const remote = await request<EditorSegment>(query('/api/editor/segment', { ...ids, path: expected.path, offset: String(expected.offset), length: String(Math.max(4, expected.end - expected.offset)) }));
        const preview = area(remote.text); preview.readOnly = true; preview.setAttribute('aria-label', t('editorUI.remote')); comparison.append(preview);
      } catch { /* Keep the base and local draft visible when the remote range is unavailable. */ }
      throw error;
    } finally { pending = false; release(); }
    await context.editor.refresh(expected.path);
  }); patch.disabled = true;
  node.append(row(path, offset, length, button(t('editorFront.segment'), async () => {
    if (pending) return;
    if (segment && text.value !== segment.text && !await confirmModal(t('editor.dirty'), t('ew.confirm'), t('editor.discard'))) return;
    const start = Number(offset.value); const bytes = Number(length.value); if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(bytes) || bytes < 4 || bytes > 262144) return;
    const selectedPath = path.value || context.editor.snapshot()?.path; if (!selectedPath) return; path.value = selectedPath;
    const current = ++serial; const local = text.value;
    const result = await request<EditorSegment>(query('/api/editor/segment', { ...ids, path: selectedPath, offset: String(start), length: String(bytes) }));
    if (current !== serial) return;
    if (text.value !== local) throw new Error(t('detail.editor_conflict'));
    segment = { ...result, path: selectedPath }; text.value = result.text; text.readOnly = false;
    offset.value = String(result.offset); status.textContent = `${result.encoding} · ${result.offset}–${result.end} / ${result.size}`; patch.disabled = false; comparison.replaceChildren();
  }), patch), status, text, comparison);
  return node;
}
