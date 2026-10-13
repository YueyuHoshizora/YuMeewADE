import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import { EditorView, keymap, rectangularSelection, crosshairCursor, gutter, GutterMarker, ViewPlugin, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { indentWithTab, isolateHistory } from '@codemirror/commands';
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
import { HighlightStyle, StreamLanguage, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { tags } from '@lezer/highlight';
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
import { readPreferences } from './editor-preferences.ts';
import type { EditorResolvedFormatPreferences } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';

/** CodeMirror's English panel strings (search, go to line, lint, folding, merge) in the UI language. */
export function editorPhrases() {
  return EditorState.phrases.of({
    'Find': t('cm.find'), 'Replace': t('cm.replace'), 'next': t('cm.next'), 'previous': t('cm.previous'), 'all': t('cm.all'),
    'match case': t('cm.matchCase'), 'regexp': t('cm.regexp'), 'by word': t('cm.byWord'), 'replace': t('cm.replaceOne'), 'replace all': t('cm.replaceAll'),
    'close': t('cm.close'), 'current match': t('cm.currentMatch'), 'on line': t('cm.onLine'), 'replaced $ matches': t('cm.replacedMatches'),
    'replaced match on line $': t('cm.replacedOnLine'), 'Go to line': t('cm.gotoLine'), 'go': t('cm.go'), 'Diagnostics': t('cm.diagnostics'),
    'No diagnostics': t('cm.noDiagnostics'), 'Completions': t('cm.completions'), 'folded code': t('cm.foldedCode'), 'unfold': t('cm.unfold'),
    'to': t('cm.to'), 'Control character': t('cm.controlCharacter'), 'Selection deleted': t('cm.selectionDeleted'), '$ unchanged lines': t('sideDiff.unchanged'),
  });
}

// basicSetup 的預設配色是亮底用色（fallback）；這組以 App 主題變數上色，深淺主題都可讀，且優先於預設。
export const appHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier], color: 'var(--purple)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: 'var(--green)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.name)], color: 'var(--yellow)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment, tags.meta], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.name)], color: 'var(--blue)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--accent)' },
  { tag: [tags.tagName, tags.heading], color: 'var(--red)', fontWeight: 'bold' },
  { tag: [tags.attributeName, tags.propertyName, tags.labelName], color: 'var(--blue)' },
  { tag: tags.link, color: 'var(--blue)', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' }, { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.invalid, color: 'var(--red)' },
]);

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
class DebugMarker extends GutterMarker {
  readonly active: boolean; readonly breakpoint: boolean;
  constructor(active: boolean, breakpoint: boolean) { super(); this.active = active; this.breakpoint = breakpoint; }
  override toDOM(): HTMLElement { const marker = document.createElement('span'); marker.className = 'debug-breakpoint'; marker.textContent = this.active ? '▶' : this.breakpoint ? '●' : '·'; return marker; }
}
class InlayHintWidget extends WidgetType {
  readonly label: string;
  constructor(label: string) { super(); this.label = label; }
  override eq(other: InlayHintWidget): boolean { return this.label === other.label; }
  override toDOM(): HTMLElement { const node = document.createElement('span'); node.className = 'editor-inlay-hint'; node.textContent = this.label; node.style.cssText = 'color:var(--muted);background:var(--panel);font-size:.85em;padding:0 .3em;'; return node; }
}

/** Compatibility surface for the workbench's v3 recovery coordinates; text lives only in CM. */
export class EditorContent {
  readonly view: EditorView;
  private language = new Compartment();
  private editable = new Compartment();
  private preferences = new Compartment();
  private debug = new Compartment();
  private proposals = new Compartment();
  private inlays = new Compartment();
  private pendingRanges: { from: number; to: number }[] = [];
  private format: EditorResolvedFormatPreferences | undefined;
  private breakpoints: number[] = [];
  private activeLine: number | undefined;
  ongutter?: (line: number) => void;
  private readonly refreshPreferences = () => this.view.dispatch({ effects: this.preferences.reconfigure(this.preferenceExtensions()) });
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
    window.addEventListener('yumeewade:editor-preferences', this.refreshPreferences);
  }
  private preferenceExtensions() {
    const prefs = { ...readPreferences(), ...(this.format?.source !== 'default' ? this.format : {}) };
    return [EditorState.tabSize.of(prefs.tabSize), indentUnit.of(prefs.insertSpaces ? ' '.repeat(prefs.tabSize) : '\t'), ...(prefs.wrap ? [EditorView.lineWrapping] : []), EditorView.theme({ '.cm-scroller': { fontFamily: prefs.fontFamily, fontSize: `${prefs.fontSize}px` } })];
  }
  resolvedFormat(format: EditorResolvedFormatPreferences | undefined): void {
    this.format = format; this.refreshPreferences();
  }
  private debugExtensions() {
    const owner = this;
    return [gutter({ class: 'debug-gutter', lineMarker: (view, line) => { const number = view.state.doc.lineAt(line.from).number; return new DebugMarker(number === owner.activeLine, owner.breakpoints.includes(number)); }, domEventHandlers: { mousedown: (view, line) => { owner.ongutter?.(view.state.doc.lineAt(line.from).number); return true; } } }),
      ViewPlugin.fromClass(class {
        decorations: DecorationSet;
        constructor(view: EditorView) { this.decorations = this.build(view); }
        update(update: { view: EditorView }): void { this.decorations = this.build(update.view); }
        build(view: EditorView): DecorationSet { return owner.activeLine && owner.activeLine <= view.state.doc.lines ? Decoration.set([Decoration.line({ class: 'debug-active-line' }).range(view.state.doc.line(owner.activeLine).from)]) : Decoration.none; }
      }, { decorations: plugin => plugin.decorations })];
  }
  debugDecoration(breakpoints: number[], active?: number): void {
    this.breakpoints = breakpoints.filter(line => Number.isSafeInteger(line) && line > 0); this.activeLine = active;
    this.view.dispatch({ effects: this.debug.reconfigure(this.debugExtensions()) });
  }
  proposalDecoration(ranges: { from: number; to: number }[]): void {
    const max = this.view.state.doc.length;
    this.pendingRanges = ranges.filter(range => Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to) && range.from >= 0 && range.to >= range.from && range.to <= max).map(range => ({ ...range }));
    const owner = this;
    this.view.dispatch({ effects: this.proposals.reconfigure([
      gutter({ class: 'proposal-gutter', lineMarker: (view, line) => owner.pendingRanges.some(range => range.from <= line.to && range.to >= line.from) ? new DebugMarker(false, true) : null }),
      ViewPlugin.fromClass(class {
        decorations: DecorationSet;
        constructor() { this.decorations = this.build(); }
        build(): DecorationSet { return Decoration.set(owner.pendingRanges.filter(range => range.to > range.from).map(range => Decoration.mark({ class: 'editor-proposal-pending' }).range(range.from, range.to)), true); }
        update(update: { docChanged: boolean; changes: { mapPos(position: number, assoc?: number): number } }): void {
          if (update.docChanged) owner.pendingRanges = owner.pendingRanges.map(range => ({ from: update.changes.mapPos(range.from, 1), to: update.changes.mapPos(range.to, -1) })).filter(range => range.to >= range.from);
          this.decorations = this.build();
        }
      }, { decorations: plugin => plugin.decorations })
    ]) });
  }
  inlayHints(hints: { line: number; character: number; label: string }[]): void {
    const doc = this.view.state.doc;
    const decorations = Decoration.set(hints.flatMap(hint => {
      if (!Number.isSafeInteger(hint.line) || hint.line < 0 || hint.line >= doc.lines || !Number.isSafeInteger(hint.character) || hint.character < 0) return [];
      const line = doc.line(hint.line + 1);
      return [Decoration.widget({ widget: new InlayHintWidget(hint.label), side: 1 }).range(line.from + Math.min(line.length, hint.character))];
    }), true);
    this.view.dispatch({ effects: this.inlays.reconfigure(ViewPlugin.fromClass(class {
      decorations = decorations;
      update(update: { docChanged: boolean }): void { if (update.docChanged) this.decorations = Decoration.none; }
    }, { decorations: plugin => plugin.decorations })) });
  }
  private state(text: string): EditorState {
    return EditorState.create({ doc: text, extensions: [
      basicSetup, syntaxHighlighting(appHighlight), rectangularSelection(), crosshairCursor(), editorPhrases(),
      EditorView.clickAddsSelectionRange.of(event => event.altKey || event.metaKey || event.ctrlKey),
      keymap.of([indentWithTab]), this.language.of([]), this.editable.of(EditorState.readOnly.of(true)), this.preferences.of(this.preferenceExtensions()),
      this.debug.of(this.debugExtensions()),
      this.proposals.of([]),
      this.inlays.of([]),
      lintGutter(), autocompletion({ override: [context => this.complete?.(context) ?? null] }),
      EditorView.theme({
        '&': { backgroundColor: 'var(--panel)', color: 'var(--c-e7eaf4)' },
        '.cm-scroller': { height: 'min(480px, 52dvh)' },
        '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderColor: 'var(--border)' },
        '.cm-content': { caretColor: 'var(--accent)' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)' },
        '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--c-e7eaf4)' },
        // CodeMirror's default panel controls use a light gradient, which hides the app's light button text in dark mode.
        '.cm-panel .cm-button': { backgroundImage: 'none', backgroundColor: 'var(--c-23283a)', color: 'var(--c-e7eaf4)', border: '1px solid var(--border)', borderRadius: '6px', padding: '2px 8px' },
        '.cm-panel .cm-textfield': { backgroundColor: 'var(--c-121620)', color: 'var(--c-e7eaf4)', border: '1px solid var(--border)', borderRadius: '6px', padding: '2px 6px' },
        '.cm-panel label': { color: 'var(--muted)' },
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
    this.refreshPreferences();
    this.replacing = false;
  }
  forget(path: string): void { this.states.delete(path); if (this.path === path) this.path = ''; }
  get value(): string { return this.view.state.doc.toString(); }
  set value(text: string) { if (text === this.value) return; this.replacing = true; this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } }); this.replacing = false; }
  /** Apply an isolated hunk without notifying the workbench's ordinary sibling mirroring. */
  applyEdits(edits: { from: number; to: number; text: string }[]): void {
    const replacing = this.replacing;
    this.replacing = true;
    try {
      this.view.dispatch({ changes: edits.map(edit => ({ from: edit.from, to: edit.to, insert: edit.text })), annotations: isolateHistory.of('full') });
    } finally { this.replacing = replacing; }
  }
  get readOnly(): boolean { return this.view.state.readOnly; }
  set readOnly(value: boolean) { this.view.dispatch({ effects: this.editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) }); }
  get selectionStart(): number { return this.view.state.selection.main.from; }
  get selectionEnd(): number { return this.view.state.selection.main.to; }
  setSelectionRange(start: number, end: number): void { const max = this.view.state.doc.length; this.view.dispatch({ selection: EditorSelection.single(Math.min(max, Math.max(0, start)), Math.min(max, Math.max(0, end))) }); }
  revealLine(line: number, character = 0): void {
    const doc = this.view.state.doc; const target = doc.line(Math.min(doc.lines, Math.max(1, line)));
    const offset = Math.min(target.to, target.from + Math.max(0, character));
    this.view.dispatch({ selection: EditorSelection.single(offset), effects: EditorView.scrollIntoView(offset, { y: 'center' }) });
  }
  setRangeText(text: string, start: number, end: number, _mode: string): void { this.view.dispatch({ changes: { from: start, to: end, insert: text }, selection: { anchor: start + text.length } }); }
  get scrollTop(): number { return this.view.scrollDOM.scrollTop; } set scrollTop(value: number) { this.view.scrollDOM.scrollTop = value; }
  get scrollLeft(): number { return this.view.scrollDOM.scrollLeft; } set scrollLeft(value: number) { this.view.scrollDOM.scrollLeft = value; }
  focus(): void { this.view.focus(); }
  dispatchEvent(_event: Event): void { this.oninput?.(); }
  diagnostics(items: Diagnostic[]): void { this.view.dispatch(setDiagnostics(this.view.state, items)); }
  destroy(): void { window.removeEventListener('yumeewade:editor-preferences', this.refreshPreferences); this.view.destroy(); this.states.clear(); }
}
