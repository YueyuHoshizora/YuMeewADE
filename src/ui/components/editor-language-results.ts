import type { EditorActionResult } from '../../shared/types.ts';
import { button, el } from './dom.ts';
export function renderAdvancedLanguage(output: HTMLElement, result: EditorActionResult, path: string, open: (path: string, line: number, character: number) => Promise<void>): void {
  const signature = result.signatureHelp;
  if (signature) for (const [index, item] of signature.signatures.entries()) {
    const node = el('div'); node.append(el('strong', '', item.label));
    if (index === signature.activeSignature && item.parameters?.[signature.activeParameter]) node.append(el('code', '', item.parameters[signature.activeParameter]));
    if (item.documentation) node.append(el('pre', '', item.documentation));
    output.append(node);
  }
  for (const hint of result.inlayHints ?? []) output.append(button(`${hint.line + 1}:${hint.character + 1} · ${hint.label}`, () => open(path, hint.line, hint.character)));
  for (const call of result.callHierarchy ?? []) output.append(button(`${call.direction === 'incoming' ? '←' : '→'} ${call.name} · ${call.path}:${call.line + 1}`, () => open(call.path, call.line, call.character)));
}
