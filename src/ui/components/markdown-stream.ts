export interface Fence { marker: string; indent: number; language: string }

export function openingFence(line: string, maxIndent = 3): Fence | undefined {
  const match = /^( *)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || match[1]!.length > maxIndent) return undefined;
  return { marker: match[2]!, indent: match[1]!.length, language: match[3]!.trim() };
}

export function closingFence(line: string, fence: Fence): boolean {
  const marker = /^ *(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return marker !== undefined && marker[0] === fence.marker[0] && marker.length >= fence.marker.length;
}

export function listMarker(line: string): { indent: number; column: number; ordered: boolean; start: number; text: string } | undefined {
  const match = /^( *)([-*+]|\d+\.) +(.+|)$/.exec(line);
  if (!match) return undefined;
  return { indent: match[1]!.length, column: line.length - match[3]!.length, ordered: match[2]!.endsWith('.'), start: Number.parseInt(match[2]!, 10), text: match[3]! };
}

// Blank lines are independent block boundaries in the renderer, except inside fences.
// Scan only newly received characters; completed blocks never need parsing again.
export class MarkdownStream {
  private block = '';
  private line = '';
  private fence: Fence | undefined;
  private lists: { indent: number; column: number }[] = [];
  private completed: string[] = [];

  push(text: string): void {
    for (const char of text.replace(/\r/g, '')) {
      this.block += char;
      if (char !== '\n') {
        this.line += char;
        continue;
      }
      if (this.fence) {
        if (closingFence(this.line, this.fence)) this.fence = undefined;
      } else {
        const marker = listMarker(this.line);
        if (marker) {
          while (this.lists.length && marker.indent < this.lists.at(-1)!.column) this.lists.pop();
          if (this.lists.length < 8) this.lists.push(marker);
          else this.lists.at(-1)!.column = marker.column;
        }
        const column = this.lists.at(-1)?.column ?? 0;
        const fence = openingFence(this.line, column + 3);
        this.fence = fence && (fence.indent <= 3 || fence.indent >= column) ? fence : undefined;
        if (!marker && (!this.fence || this.fence.indent < column)) this.lists = [];
      }
      if (!this.fence && !this.line.trim()) {
        this.lists = [];
        this.completed.push(this.block);
        this.block = '';
      }
      this.line = '';
    }
  }

  takeCompleted(): string[] {
    const blocks = this.completed;
    this.completed = [];
    return blocks;
  }

  tail(): string {
    return this.block;
  }
}
