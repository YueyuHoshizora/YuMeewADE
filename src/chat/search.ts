import { AppError } from '../shared/errors.ts';
import type { ChatRow, SearchHit, SearchResult, TaskSections } from '../shared/types.ts';

export interface SearchReaders {
  projects(): Promise<ReadonlyArray<{ id: string }>>;
  tasks(project: string): Promise<ReadonlyArray<{ id: string; title: string }>>;
  readLog(project: string, task: string): Promise<readonly ChatRow[]>;
  /** The task file's free-text record (done / next / cautions / memo); omitted readers skip it. */
  sections?(project: string, task: string): Promise<TaskSections>;
}

export function searchQuery(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('bad_request', 'field_required', { field: 'q' });
  const query = value.trim();
  if (!query) throw new AppError('bad_request', 'field_required', { field: 'q' });
  if (query.length > 200) throw new AppError('bad_request', 'field_too_long', { field: 'q' });
  return query;
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  const excerpt = text.slice(start, end).replace(/\s+/gu, ' ').trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`;
}

/** Bounds the work of a no-match search across every conversation; hits stop at 50 independently. */
export const SEARCH_SCAN_ROWS = 200_000;

/**
 * Reader order is retained; only user/assistant text is searched, newest first.
 * Text and query are compared in NFC: macOS file names are decomposed (NFD), so a path quoted in a conversation would
 * otherwise never match the same characters typed in the search box. Snippets come from the NFC text they matched.
 */
export async function search(readers: SearchReaders, value: unknown, scanRows = SEARCH_SCAN_ROWS): Promise<SearchResult> {
  const query = searchQuery(value).normalize('NFC').toLocaleLowerCase();
  const hits: SearchHit[] = [];
  let scanned = 0;
  for (const project of await readers.projects()) {
    for (const task of await readers.tasks(project.id)) {
      const text = `${task.id} ${task.title}`.normalize('NFC');
      const taskIndex = text.toLocaleLowerCase().indexOf(query);
      if (taskIndex !== -1) {
        hits.push({ project: project.id, task: task.id, title: task.title, kind: 'task', snippet: snippet(text, taskIndex, query.length) });
        if (hits.length === 50) return { hits, truncated: true };
      }
      if (readers.sections) {
        // One hit per task for its record: the first matching line, in section order.
        const record = await readers.sections(project.id, task.id);
        for (const raw of [...record.done, ...record.next, ...record.cautions, ...record.memo]) {
          if (++scanned > scanRows) return { hits, truncated: false, partial: true };
          // Ledger lines carry markdown list markers; the snippet shows the text itself.
          const line = raw.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '').normalize('NFC');
          const match = line.toLocaleLowerCase().indexOf(query);
          if (match === -1) continue;
          hits.push({ project: project.id, task: task.id, title: task.title, kind: 'record', snippet: snippet(line, match, query.length) });
          if (hits.length === 50) return { hits, truncated: true };
          break;
        }
      }
      const rows = await readers.readLog(project.id, task.id);
      for (let index = rows.length - 1; index >= 0; index--) {
        if (++scanned > scanRows) return { hits, truncated: false, partial: true };
        const row = rows[index]!;
        if (row.role !== 'user' && row.role !== 'assistant') continue;
        const body = row.text.normalize('NFC');
        const match = body.toLocaleLowerCase().indexOf(query);
        if (match === -1) continue;
        hits.push({
          project: project.id,
          task: task.id,
          title: task.title,
          kind: 'chat',
          index,
          role: row.role,
          at: row.at,
          snippet: snippet(body, match, query.length),
        });
        if (hits.length === 50) return { hits, truncated: true };
      }
    }
  }
  return { hits, truncated: false };
}
