export function selectionMention(path: string, startLine: number, endLine: number, empty: boolean): string {
  if (empty) return `@${path} `;
  return `@${path}#L${startLine}${startLine === endLine ? '' : `-${endLine}`} `;
}
