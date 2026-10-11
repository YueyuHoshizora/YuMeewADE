import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import { EditorView, keymap, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { kotlin } from '@codemirror/legacy-modes/mode/clike';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';

export function editorLanguage(path: string) {
  const ext = path.split('.').at(-1)?.toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ typescript: ext.startsWith('ts'), jsx: ext.endsWith('x') });
    case 'json': return json(); case 'py': return python(); case 'rs': return rust(); case 'go': return go();
    case 'css': case 'scss': return css(); case 'html': case 'vue': return html(); case 'md': return markdown();
    case 'c': case 'h': case 'cpp': case 'hpp': return cpp(); case 'java': return java(); case 'kt': return StreamLanguage.define(kotlin);
    case 'php': return php(); case 'sql': return sql(); case 'xml': case 'svg': return xml(); case 'yaml': case 'yml': return yaml();
    case 'toml': return StreamLanguage.define(toml); case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell);
    case 'rb': return StreamLanguage.define(ruby); case 'swift': return StreamLanguage.define(swift); case 'lua': return StreamLanguage.define(lua);
    case 'ini': return StreamLanguage.define(properties);
    default: return /(^|\/)dockerfile$/i.test(path) ? StreamLanguage.define(dockerFile) : [];
  }
}

/** Compatibility surface for the workbench's v3 recovery coordinates; text lives only in CM. */
export class EditorContent {
  readonly view: EditorView;
  private language = new Compartment();
  private editable = new Compartment();
  private states = new Map<string, EditorState>();
  private path = '';
  private replacing = false;
  oninput?: () => void; onfocus?: () => void; onscroll?: () => void; onselect?: () => void;
  onkeydown?: (event: KeyboardEvent) => void;
  complete?: (context: CompletionContext) => Promise<CompletionResult | null>;
  constructor(parent: HTMLElement, label: string) {
    this.view = new EditorView({ parent, state: this.state(''), });
    this.view.contentDOM.setAttribute('aria-label', label);
    this.view.dom.addEventListener('focusin', () => this.onfocus?.());
    this.view.dom.addEventListener('keydown', event => this.onkeydown?.(event));
    this.view.scrollDOM.addEventListener('scroll', () => this.onscroll?.());
  }
  private state(text: string): EditorState {
    return EditorState.create({ doc: text, extensions: [
      basicSetup, rectangularSelection(), crosshairCursor(),
      EditorView.clickAddsSelectionRange.of(event => event.altKey || event.metaKey || event.ctrlKey),
      keymap.of([indentWithTab]), this.language.of([]), this.editable.of(EditorState.readOnly.of(true)),
      lintGutter(), autocompletion({ override: [context => this.complete?.(context) ?? null] }),
      EditorView.theme({
        '&': { backgroundColor: 'var(--panel)', color: 'var(--c-e7eaf4)' },
        '.cm-scroller': { height: 'min(480px, 52dvh)', fontFamily: 'ui-monospace, monospace' },
        '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderColor: 'var(--border)' },
        '.cm-content': { caretColor: 'var(--accent)' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)' },
        '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--c-e7eaf4)' }
      }),
      EditorView.updateListener.of(update => {
        if (this.replacing) return;
        if (update.docChanged) this.oninput?.();
        if (update.selectionSet) this.onselect?.();
      })
    ] });
  }
  open(path: string, text: string): void {
    if (this.path) this.states.set(this.path, this.view.state);
    this.path = path;
    this.replacing = true;
    const state = this.states.get(path);
    this.view.setState(state?.doc.toString() === text ? state : this.state(text));
    this.view.dispatch({ effects: this.language.reconfigure(editorLanguage(path)) });
    this.replacing = false;
  }
  forget(path: string): void { this.states.delete(path); if (this.path === path) this.path = ''; }
  get value(): string { return this.view.state.doc.toString(); }
  set value(text: string) { if (text === this.value) return; this.replacing = true; this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } }); this.replacing = false; }
  get readOnly(): boolean { return this.view.state.readOnly; }
  set readOnly(value: boolean) { this.view.dispatch({ effects: this.editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) }); }
  get selectionStart(): number { return this.view.state.selection.main.from; }
  get selectionEnd(): number { return this.view.state.selection.main.to; }
  setSelectionRange(start: number, end: number): void { const max = this.view.state.doc.length; this.view.dispatch({ selection: EditorSelection.single(Math.min(max, Math.max(0, start)), Math.min(max, Math.max(0, end))) }); }
  setRangeText(text: string, start: number, end: number, _mode: string): void { this.view.dispatch({ changes: { from: start, to: end, insert: text }, selection: { anchor: start + text.length } }); }
  get scrollTop(): number { return this.view.scrollDOM.scrollTop; } set scrollTop(value: number) { this.view.scrollDOM.scrollTop = value; }
  get scrollLeft(): number { return this.view.scrollDOM.scrollLeft; } set scrollLeft(value: number) { this.view.scrollDOM.scrollLeft = value; }
  focus(): void { this.view.focus(); }
  dispatchEvent(_event: Event): void { this.oninput?.(); }
  diagnostics(items: Diagnostic[]): void { this.view.dispatch(setDiagnostics(this.view.state, items)); }
  destroy(): void { this.view.destroy(); this.states.clear(); }
}
