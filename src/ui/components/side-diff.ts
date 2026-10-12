import type { MergeView } from '@codemirror/merge';
import type { GitDiffContents } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, row, run } from './dom.ts';

const preference = 'yumeewade:side-diff';
/** Unified remains available for review comments and precise line staging. */
export function sideDiff(unified: HTMLElement, ids: { project: string; task?: string; path: string; mode: 'copy' | 'working' | 'staged' }): HTMLElement {
  const wrapper = el('div', 'form');
  const host = el('div'); host.hidden = true;
  const notice = el('p', 'warning'); notice.hidden = true;
  let merge: MergeView | undefined;
  let side = false;
  let serial = 0;
  let closed = false;
  const destroy = () => { merge?.destroy(); merge = undefined; host.replaceChildren(); };
  const toggle = button(t('sideDiff.side'), () => run(() => show(!side, true)));
  toggle.setAttribute('aria-pressed', 'false');
  wrapper.append(row(toggle), notice, unified, host);
  async function show(value: boolean, remember = false): Promise<void> {
    const current = ++serial;
    destroy(); side = false; unified.hidden = false; host.hidden = true; notice.hidden = true;
    toggle.textContent = t('sideDiff.side'); toggle.setAttribute('aria-pressed', 'false');
    if (remember) { try { localStorage.setItem(preference, String(value)); } catch { /* Storage can be disabled. */ } }
    if (!value) return;
    const contents = await request<GitDiffContents>(query('/api/git/diff-contents', ids));
    if (current !== serial || closed) return;
    if (contents.binary || contents.truncated) {
      notice.textContent = t(contents.binary ? 'sideDiff.binary' : 'sideDiff.large'); notice.hidden = false; return;
    }
    // Load CodeMirror only after the user requests the heavy comparison view.
    const [{ MergeView }, { EditorState }, { EditorView, lineNumbers }, { syntaxHighlighting }, { appHighlight, editorLanguage, editorPhrases }] = await Promise.all([import('@codemirror/merge'), import('@codemirror/state'), import('@codemirror/view'), import('@codemirror/language'), import('./editor-engine.ts')]);
    if (current !== serial || closed) return;
    // Same CSS-variable colors as the main editor so gutters and collapsed-line bars follow the light/dark theme.
    const extensions = [lineNumbers(), editorLanguage(ids.path), syntaxHighlighting(appHighlight), EditorState.readOnly.of(true), EditorView.editable.of(false), editorPhrases(), EditorView.theme({
      '&': { backgroundColor: 'var(--panel)', color: 'var(--c-e7eaf4)' }, '.cm-scroller': { overflow: 'visible' },
      '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderColor: 'var(--border)' },
      '.cm-collapsedLines': { background: 'color-mix(in srgb, var(--accent) 10%, var(--panel))', color: 'var(--muted)' },
    })];
    unified.hidden = true; host.hidden = false; side = true;
    const labels = el('div', 'side-diff-labels'); labels.append(el('strong', '', t('sideDiff.before')), el('strong', '', t('sideDiff.after')));
    host.append(labels);
    merge = new MergeView({ parent: host, a: { doc: contents.before, extensions }, b: { doc: contents.after, extensions }, collapseUnchanged: { margin: 3, minSize: 8 }, highlightChanges: true, gutter: true });
    // One scroll container preserves MergeView's aligned rows on both sides.
    merge.dom.style.maxHeight = '60vh'; merge.dom.style.overflow = 'auto'; merge.dom.style.minWidth = '600px';
    host.style.overflowX = 'auto';
    toggle.textContent = t('sideDiff.unified'); toggle.setAttribute('aria-pressed', 'true');
  }
  // Wait for modal attachment before creating CodeMirror; release it on every close path.
  requestAnimationFrame(() => {
    const dialog = wrapper.closest('dialog');
    dialog?.addEventListener('close', () => { closed = true; ++serial; destroy(); }, { once: true });
    try { if (localStorage.getItem(preference) === 'true') void run(() => show(true)); } catch { /* Storage can be disabled. */ }
  });
  return wrapper;
}
