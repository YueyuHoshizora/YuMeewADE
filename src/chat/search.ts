import { AppError } from '../shared/errors.ts';
import type { ChatRow, SearchHit, SearchResult } from '../shared/types.ts';

export interface SearchReaders {
  projects(): Promise<ReadonlyArray<{ id: string }>>;
  tasks(project: string): Promise<ReadonlyArray<{ id: string; title: string }>>;
  readLog(project: string, task: string): Promise<readonly ChatRow[]>;
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

/** Reader order is retained; only user/assistant text is searched, newest first. */
export async function search(readers: SearchReaders, value: unknown): Promise<SearchResult> {
  const query = searchQuery(value).toLocaleLowerCase();
  const hits: SearchHit[] = [];
  for (const project of await readers.projects()) {
    for (const task of await readers.tasks(project.id)) {
      const text = `${task.id} ${task.title}`;
      const taskIndex = text.toLocaleLowerCase().indexOf(query);
      if (taskIndex !== -1) {
        hits.push({ project: project.id, task: task.id, title: task.title, kind: 'task', snippet: snippet(text, taskIndex, query.length) });
        if (hits.length === 50) return { hits, truncated: true };
      }
      const rows = await readers.readLog(project.id, task.id);
      for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index]!;
        if (row.role !== 'user' && row.role !== 'assistant') continue;
        const match = row.text.toLocaleLowerCase().indexOf(query);
        if (match === -1) continue;
        hits.push({
          project: project.id,
          task: task.id,
          title: task.title,
          kind: 'chat',
          index,
          role: row.role,
          at: row.at,
          snippet: snippet(row.text, match, query.length),
        });
        if (hits.length === 50) return { hits, truncated: true };
      }
    }
  }
  return { hits, truncated: false };
}
