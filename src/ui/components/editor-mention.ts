import { mentionReference } from '../../shared/mention-syntax.ts';

export function selectionMention(path: string, startLine: number, endLine: number, empty: boolean): string {
  if (empty) return `${mentionReference(path)} `;
  return `${mentionReference(`${path}#L${startLine}${startLine === endLine ? '' : `-${endLine}`}`)} `;
}
