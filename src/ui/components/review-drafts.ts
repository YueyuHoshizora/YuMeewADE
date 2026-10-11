import type { ReviewDraft } from '../../shared/types.ts';
import type { DiffLine } from './diff.ts';
import { request, query } from '../api.ts';

export function reviewKey(path: string, line: Pick<DiffLine, 'oldLine' | 'newLine'>): string {
  return JSON.stringify([path, line.oldLine ?? null, line.newLine ?? null]);
}

export function partitionReviewDrafts(reviews: ReviewDraft[], hash: string): { stale: ReviewDraft[]; current: Map<string, ReviewDraft> } {
  return {
    stale: reviews.filter(review => review.hash !== hash),
    current: new Map(reviews.filter(review => review.hash === hash).map(review => [reviewKey(review.path, review), review])),
  };
}
export async function reviewDrafts(project: string, task: string, diff: string): Promise<{
  stale: ReviewDraft[]; get: (path: string, line: DiffLine) => ReviewDraft | undefined;
  set: (path: string, line: DiffLine, comment: string) => Promise<void>;
  values: () => ReviewDraft[]; ready: () => Promise<void>; clear: () => Promise<void>;
}> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(diff));
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const draft = await request<{ reviews: ReviewDraft[] }>(query('/api/chat/draft', { project, scope: task }));
  const { stale, current } = partitionReviewDrafts(draft.reviews, hash);
  let chain: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    const reviews = [...stale, ...current.values()];
    chain = chain.catch(() => undefined).then(async () => { await request('/api/chat/draft', { project, scope: task, reviews }); });
    return chain;
  }
  return { stale, get: (path, line) => {
    const item = current.get(reviewKey(path, line));
    return item?.code === line.text.slice(1).trim() ? item : undefined;
  }, set: (path, line, comment) => {
    const key = reviewKey(path, line);
    if (comment.trim()) current.set(key, { path, hash, code: line.text.slice(1).trim(), comment, ...(line.oldLine === undefined ? {} : { oldLine: line.oldLine }), ...(line.newLine === undefined ? {} : { newLine: line.newLine }) });
    else current.delete(key);
    return persist();
  }, values: () => [...current.values()], ready: () => chain, clear: async () => {
    await chain;
    const reviews = [...stale];
    await request('/api/chat/draft', { project, scope: task, reviews });
    current.clear();
  } };
}
