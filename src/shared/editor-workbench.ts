import type { EditorDocument, EditorLocation, EditorDiagnostic } from './types.ts';
export type EditorEncoding = 'UTF8' | 'UTF8-BOM' | 'UTF16LE' | 'UTF16BE';
export interface EditorSegment { text: string; revision: string; offset: number; end: number; size: number; encoding: EditorEncoding }
/** `range.sha256` hashes the bytes the edit wrote at `range`: a restore only applies while those exact bytes are still there. */
export interface EditorHistoryEntry { id: string; path: string; revision: string; text: string; timestamp: number; reason: 'save' | 'apply' | 'mutate' | 'segment'; encoding?: EditorEncoding; range?: { offset: number; end: number; sha256?: string } }
export type EditorAction = 'definition' | 'references' | 'diagnostics' | 'completion' | 'hover' | 'rename' | 'format' | 'codeActions' | 'documentSymbols' | 'workspaceSymbols' | 'signatureHelp' | 'implementation' | 'callHierarchy' | 'inlayHints';
export interface EditorBufferSnapshot { path: string; revision: string; text: string }
export interface EditorChange { path: string; revision: string; text: string; baseText?: string }
export interface EditorSuggestion { label: string; detail?: string; insertText: string; start?: number; end?: number }
export interface EditorSymbol extends EditorLocation { name: string; kind: number; container?: string }
/** `truncated`: the server listed more symbols than are returned (only the first 500 are kept). */
export interface EditorActionResult { locations: EditorLocation[]; diagnostics: EditorDiagnostic[]; hover?: string; suggestions?: EditorSuggestion[]; changes?: EditorChange[]; actions?: { title: string; changes: EditorChange[] }[]; symbols?: EditorSymbol[]; truncated?: boolean; signatureHelp?: { signatures: { label: string; documentation?: string; parameters?: string[] }[]; activeSignature: number; activeParameter: number }; inlayHints?: { line: number; character: number; label: string }[]; callHierarchy?: (EditorLocation & { name: string; direction: 'incoming' | 'outgoing' })[] }
export interface EditorSearchHit { path: string; revision: string; line: number; character: number; end: number; preview: string }
export interface EditorSearchResult { hits: EditorSearchHit[]; scanned: number; total: number; page: number; pageSize: number; truncated: boolean }
export interface EditorMutation { action: 'createFile' | 'createFolder' | 'rename' | 'delete'; path: string; destination?: string; revision?: string; confirmation?: string }
export interface EditorProblem extends EditorDiagnostic { path: string }
export interface EditorRecovery { document: EditorDocument; text: string; start: number; end: number; top: number; left: number; encoding?: EditorEncoding }
export interface EditorRevisionCheck { path: string; revision: string }
export interface EditorRevisionResult { changes: { path: string; status: 'changed' | 'unchanged' | 'missing'; revision?: string }[] }
export interface EditorMergeResult { text: string; revision: string; conflicts: boolean }
