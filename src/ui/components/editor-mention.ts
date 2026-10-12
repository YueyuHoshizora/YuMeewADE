import { mentionText } from './mention.ts';

export function selectionMention(path: string, startLine: number, endLine: number, empty: boolean): string {
  if (empty) return `${mentionText(path)} `;
  return `${mentionText(`${path}#L${startLine}${startLine === endLine ? '' : `-${endLine}`}`)} `;
}
