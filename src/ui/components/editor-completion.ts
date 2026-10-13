import type { EditorSuggestion } from '../../shared/types.ts';

/** CodeMirror change arrays refer to the original document, including the auto-import edits. */
export function completionChanges(suggestion: EditorSuggestion, from: number, to: number): { from: number; to: number; insert: string }[] {
  return [{ from: suggestion.start ?? from, to: suggestion.end ?? to, insert: suggestion.insertText }, ...(suggestion.additionalTextEdits ?? []).map(edit => ({ from: edit.start, to: edit.end, insert: edit.insertText }))];
}
