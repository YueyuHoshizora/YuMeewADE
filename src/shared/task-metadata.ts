import { AppError } from './errors.ts';
import type { Task } from './types.ts';

export function validDue(value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validTag(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 60 && value === value.trim() && !/[\r\n\0]/u.test(value);
}
/** Tags as written in a task file: the list form, or a hand-written `tags: a, b` scalar split like the tag field. Reading the
 * scalar as no tags would also lose it, since the next tag or due-date save writes the list back. */
export function fileTags(value: unknown): string[] {
  const list: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(tag => tag.trim()) : [];
  return [...new Set(list.filter(validTag))].slice(0, 32);
}
export function taskMetadata(input: { due?: unknown; tags?: unknown }): { due?: string; tags?: string[] } {
  const result: { due?: string; tags?: string[] } = {};
  if (input.due !== undefined) {
    if (!validDue(input.due)) throw new AppError('bad_request', 'field_type', { field: 'due' });
    result.due = input.due;
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 32 || !input.tags.every(validTag)) throw new AppError('bad_request', 'field_type', { field: 'tags' });
    result.tags = [...new Set(input.tags)];
  }
  return result;
}
export function today(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function overdue(task: Pick<Task, 'due' | 'state'>, day = today()): boolean {
  return task.state !== '完成' && !!task.due && task.due < day;
}
