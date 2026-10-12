import type { EditorDocument, EditorLocation, EditorDiagnostic } from './types.ts';
export type EditorAction = 'definition' | 'references' | 'diagnostics' | 'completion' | 'hover' | 'rename' | 'format' | 'codeActions' | 'documentSymbols' | 'workspaceSymbols' | 'signatureHelp' | 'implementation' | 'callHierarchy' | 'inlayHints';
export interface EditorBufferSnapshot { path: string; revision: string; text: string }
export interface EditorChange { path: string; revision: string; text: string; baseText?: string }
export interface EditorSuggestion { label: string; detail?: string; insertText: string; start?: number; end?: number }
export interface EditorSymbol extends EditorLocation { name: string; kind: number; container?: string }
export interface EditorActionResult { locations: EditorLocation[]; diagnostics: EditorDiagnostic[]; hover?: string; suggestions?: EditorSuggestion[]; changes?: EditorChange[]; actions?: { title: string; changes: EditorChange[] }[]; symbols?: EditorSymbol[]; signatureHelp?: { signatures: { label: string; documentation?: string; parameters?: string[] }[]; activeSignature: number; activeParameter: number }; inlayHints?: { line: number; character: number; label: string }[]; callHierarchy?: (EditorLocation & { name: string; direction: 'incoming' | 'outgoing' })[] }
export interface EditorSearchHit { path: string; revision: string; line: number; character: number; end: number; preview: string }
export interface EditorSearchResult { hits: EditorSearchHit[]; scanned: number; total: number; page: number; pageSize: number; truncated: boolean }
export interface EditorMutation { action: 'createFile' | 'createFolder' | 'rename' | 'delete'; path: string; destination?: string; revision?: string; confirmation?: string }
export interface EditorProblem extends EditorDiagnostic { path: string }
export interface EditorRecovery { document: EditorDocument; text: string; start: number; end: number; top: number; left: number }
export interface EditorRevisionCheck { path: string; revision: string }
export interface EditorRevisionResult { changes: { path: string; status: 'changed' | 'unchanged' | 'missing'; revision?: string }[] }
export interface EditorMergeResult { text: string; revision: string; conflicts: boolean }
