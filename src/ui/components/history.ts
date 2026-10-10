import type { ChatHistory, ChatRow } from '../../shared/types.ts';

export class HistoryWindow {
  rows: ChatRow[] = [];
  start = 0;
  revision = 0;

  reset(page: ChatHistory): void {
    this.rows = [...page.rows];
    this.start = page.start;
    this.revision++;
  }

  prepend(page: ChatHistory, before: number, revision: number): boolean {
    // A reconnect snapshot supersedes requests made against the previous window.
    if (revision !== this.revision || before !== this.start) return false;
    if (page.start + page.rows.length !== before || page.start >= before) return false;
    this.rows.unshift(...page.rows);
    this.start = page.start;
    return true;
  }
}
