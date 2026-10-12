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
  let start = Math.max(0, index - 60);
  let end = Math.min(text.length, index + length + 60);
  // Never cut an astral character (emoji, rare CJK) in half: a lone surrogate renders as a replacement character.
  const high = (at: number): boolean => (text.charCodeAt(at) & 0xfc00) === 0xd800;
  const low = (at: number): boolean => (text.charCodeAt(at) & 0xfc00) === 0xdc00;
  if (low(start) && high(start - 1)) start--;
  if (high(end - 1) && low(end)) end++;
  const excerpt = text.slice(start, end).replace(/\s+/gu, ' ').trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`;
}

/**
 * Index of `query` (already lower-cased) in `text`, as an index into `text` itself. Lower-casing can lengthen a string
 * (Turkish İ becomes i + combining dot), so an index into the lower-cased copy would place the snippet past the match.
 */
function locate(text: string, query: string): number {
  const lower = text.toLocaleLowerCase();
  const at = lower.indexOf(query);
  if (at <= 0 || lower.length === text.length) return at;
  let original = 0; let lowered = 0;
  for (const character of text) {
    if (lowered >= at) break;
    lowered += character.toLocaleLowerCase().length; original += character.length;
  }
  return original;
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
      const taskIndex = locate(text, query);
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
          const match = locate(line, query);
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
        // Questions are parsed out of the reply text into `asks`; they are part of what the AI said.
        const asks = row.role === 'assistant' ? (row.asks ?? []).map(ask => [ask.question, ...ask.options].join('\n')) : [];
        const body = [row.text, ...asks].filter(Boolean).join('\n').normalize('NFC');
        const match = locate(body, query);
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
