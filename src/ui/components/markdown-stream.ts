// Blank lines are independent block boundaries in the renderer, except inside fences.
// Scan only newly received characters; completed blocks never need parsing again.
export class MarkdownStream {
  private block = '';
  private line = '';
  private fenced = false;
  private completed: string[] = [];

  push(text: string): void {
    for (const char of text.replace(/\r/g, '')) {
      this.block += char;
      if (char !== '\n') {
        this.line += char;
        continue;
      }
      if (this.line.startsWith('```')) this.fenced = !this.fenced;
      if (!this.fenced && !this.line.trim()) {
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
