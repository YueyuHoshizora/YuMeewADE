import { Worker } from 'node:worker_threads';
import { AppError } from '../shared/errors.ts';
export interface SearchOptions { page?: number; pageSize?: number; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; include?: string[]; exclude?: string[]; mode?: 'content' | 'files' }
export interface SearchMatches { offsets: [number, number][]; truncated: boolean }
export interface Matcher { match(text: string): Promise<SearchMatches>; close(): void }

const MAX_MATCHES = 10000;
/** Per-text budget for user regexes; a catastrophic pattern is stopped instead of freezing the core. */
const REGEX_MS = 300;

/**
 * One matcher per search. User regexes run in a single worker reused for every file (spawning one per file cost ~10 ms each),
 * and the worker is terminated if one text exceeds its time budget.
 */
export function createMatcher(query: string, options: SearchOptions): Matcher {
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Editor regex search is line-oriented: ^ and $ anchor each line, as in other IDE search panels.
  const flags = options.caseSensitive ? 'gmu' : 'gimu';
  try { new RegExp(source, flags); } catch { throw new AppError('bad_request', 'search_regex_invalid'); }
  if (!options.regex) return { match: async text => literal(text, source, options), close() {} };
  // With the Unicode flag, advancing into a surrogate pair makes exec return the same empty match again.
  const worker = new Worker(`const {parentPort,workerData:d}=require('node:worker_threads');const r=new RegExp(d.source,d.flags);const word=c=>c!==undefined&&/[\\p{L}\\p{N}_]/u.test(c);parentPort.on('message',text=>{r.lastIndex=0;const offsets=[];let m;let truncated=false;while((m=r.exec(text))){const start=m.index,end=start+m[0].length;if(!d.wholeWord||(!word(text[start-1])&&!word(text[end]))){if(offsets.length===${MAX_MATCHES}){truncated=true;break;}offsets.push([start,end]);}if(!m[0].length)r.lastIndex+=text.codePointAt(r.lastIndex)>0xffff?2:1;}parentPort.postMessage({offsets,truncated});});`, { eval: true, workerData: { source, flags, wholeWord: options.wholeWord }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  worker.unref();
  let failure: unknown; let pending: { resolve: (value: SearchMatches) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout } | undefined;
  const fail = (error: unknown): void => {
    failure ??= error; void worker.terminate();
    if (pending) { clearTimeout(pending.timer); pending.reject(failure); pending = undefined; }
  };
  worker.on('message', (value: SearchMatches) => { if (!pending) return; clearTimeout(pending.timer); const { resolve } = pending; pending = undefined; resolve(value); });
  worker.once('error', fail);
  worker.once('exit', () => fail(new AppError('unavailable')));
  return {
    match(text) {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new AppError('conflict'));
      const { promise, resolve, reject } = Promise.withResolvers<SearchMatches>();
      pending = { resolve, reject, timer: setTimeout(() => fail(new AppError('too_large', 'search_regex_slow')), REGEX_MS) };
      worker.postMessage(text);
      return promise;
    },
    close() { failure ??= new AppError('unavailable'); void worker.terminate(); },
  };
}

function literal(text: string, source: string, options: SearchOptions): SearchMatches {
  const matcher = new RegExp(source, options.caseSensitive ? 'gu' : 'giu'); const offsets: [number, number][] = [];
  for (const match of text.matchAll(matcher)) {
    const start = match.index; const end = start + match[0].length;
    if (options.wholeWord && (start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1]!) || end < text.length && /[\p{L}\p{N}_]/u.test(text[end]!))) continue;
    if (offsets.length === MAX_MATCHES) return { offsets, truncated: true };
    offsets.push([start, end]);
  }
  return { offsets, truncated: false };
}
