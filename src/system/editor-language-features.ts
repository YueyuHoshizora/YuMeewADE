import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import type { LanguageClient } from './editor-lsp.ts';
import type { EditorActionResult } from '../shared/editor-workbench.ts';
export async function advancedLanguage(client: LanguageClient, action: string, uri: string, root: string, text: string, line: number, character: number, allowed: (relative: string) => Promise<unknown>): Promise<Partial<EditorActionResult>> {
  const providers: Record<string, string> = { signatureHelp: 'signatureHelpProvider', implementation: 'implementationProvider', callHierarchy: 'callHierarchyProvider', inlayHints: 'inlayHintProvider' };
  if (!client.capabilities[providers[action]!]) throw new AppError('unavailable', 'editor_language_unavailable');
  const position = { line, character }; const textDocument = { uri };
  const validPosition = (value: unknown): value is { line: number; character: number } => !!value && typeof value === 'object' && 'line' in value && 'character' in value && Number.isSafeInteger(value.line) && Number.isSafeInteger(value.character) && (value.line as number) >= 0 && (value.character as number) >= 0;
  if (action === 'signatureHelp') {
    const value = await client.request('textDocument/signatureHelp', { textDocument, position }) as { signatures?: unknown[]; activeSignature?: number; activeParameter?: number } | null;
    if (!value) return { signatureHelp: { signatures: [], activeSignature: 0, activeParameter: 0 } };
    if (!Array.isArray(value.signatures) || value.signatures.length > 50) throw new AppError('bad_request');
    const signatures = value.signatures.map(raw => {
      const item = raw as { label?: unknown; documentation?: unknown; parameters?: unknown[] };
      if (typeof item.label !== 'string' || item.label.length > 4000 || item.parameters && (!Array.isArray(item.parameters) || item.parameters.length > 100)) throw new AppError('bad_request');
      const documentation = typeof item.documentation === 'string' ? item.documentation : item.documentation && typeof item.documentation === 'object' && 'value' in item.documentation && typeof item.documentation.value === 'string' ? item.documentation.value : undefined;
      return { label: item.label, ...(documentation ? { documentation: documentation.slice(0, 4000) } : {}), parameters: (item.parameters ?? []).map(raw => { const p = raw as { label?: unknown }; if (typeof p.label === 'string') return p.label.slice(0, 1000); if (Array.isArray(p.label) && p.label.length === 2 && p.label.every(Number.isSafeInteger) && p.label[0] >= 0 && p.label[1] >= p.label[0] && p.label[1] <= (item.label as string).length) return (item.label as string).slice(p.label[0], p.label[1]); throw new AppError('bad_request'); }) };
    });
    return { signatureHelp: { signatures, activeSignature: Number.isSafeInteger(value.activeSignature) && value.activeSignature! >= 0 && value.activeSignature! < signatures.length ? value.activeSignature! : 0, activeParameter: Number.isSafeInteger(value.activeParameter) && value.activeParameter! >= 0 && value.activeParameter! < 100 ? value.activeParameter! : 0 } };
  }
  if (action === 'inlayHints') {
    const lines = text.split('\n');
    const result = await client.request('textDocument/inlayHint', { textDocument, range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } } });
    if (result === null) return { inlayHints: [] }; if (!Array.isArray(result) || result.length > 1000) throw new AppError('too_large');
    return { inlayHints: result.map(raw => { const item = raw as { position?: unknown; label?: unknown }; if (!validPosition(item.position) || item.position.line >= lines.length || item.position.character > lines[item.position.line]!.length) throw new AppError('bad_request'); const label = typeof item.label === 'string' ? item.label : Array.isArray(item.label) ? item.label.map(part => part && typeof part === 'object' && typeof part.value === 'string' ? part.value : '').join('') : ''; if (label.length > 2000) throw new AppError('too_large'); return { ...item.position, label }; }) };
  }
  if (action === 'callHierarchy') {
    const result = await client.request('textDocument/prepareCallHierarchy', { textDocument, position });
    if (result === null) return { callHierarchy: [] }; if (!Array.isArray(result) || result.length > 20) throw new AppError('too_large');
    const callHierarchy: NonNullable<EditorActionResult['callHierarchy']> = [];
    for (const item of result) {
      if (!item || typeof item !== 'object' || typeof item.uri !== 'string') throw new AppError('bad_request');
      const relative = path.relative(root, fileURLToPath(item.uri)).split(path.sep).join('/'); await allowed(relative);
      for (const direction of ['incoming', 'outgoing'] as const) {
        const calls = await client.request(`callHierarchy/${direction}Calls`, { item });
        if (calls === null) continue; if (!Array.isArray(calls) || calls.length > 100) throw new AppError('too_large');
        for (const call of calls) { const target = direction === 'incoming' ? call.from : call.to; if (!target || typeof target.name !== 'string' || target.name.length > 1000 || typeof target.uri !== 'string' || !validPosition(target.selectionRange?.start)) throw new AppError('bad_request'); const relative = path.relative(root, fileURLToPath(target.uri)).split(path.sep).join('/'); try { await allowed(relative); } catch { continue; } if (callHierarchy.length >= 500) throw new AppError('too_large'); callHierarchy.push({ name: target.name, path: relative, ...target.selectionRange.start, direction }); }
      }
    }
    return { callHierarchy };
  }
  return {};
}
