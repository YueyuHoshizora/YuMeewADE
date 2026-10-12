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
  const querySource = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Keep boundaries inside the expression, as in replacement previews: alternatives and lazy matches may backtrack.
  const source = options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${querySource})(?![\\p{L}\\p{N}_])` : querySource;
  // Editor regex search is line-oriented: ^ and $ anchor each line, as in other IDE search panels. JavaScript also treats
  // the gap inside CRLF as a line boundary, so texts are matched with LF endings and offsets mapped back (`lineMatch`).
  const flags = options.caseSensitive ? 'gmu' : 'gimu';
  try { new RegExp(source, flags); } catch { throw new AppError('bad_request', 'search_regex_invalid'); }
  if (!options.regex) return { match: async text => lineMatch(text, lf => literal(lf, source, options)), close() {} };
  // With the Unicode flag, advancing into a surrogate pair makes exec return the same empty match again.
  const worker = new Worker(`const {parentPort,workerData:d}=require('node:worker_threads');const r=new RegExp(d.source,d.flags);parentPort.on('message',text=>{r.lastIndex=0;const offsets=[];let m;let truncated=false;while((m=r.exec(text))){const start=m.index,end=start+m[0].length;if(offsets.length===${MAX_MATCHES}){truncated=true;break;}offsets.push([start,end]);if(!m[0].length)r.lastIndex+=text.codePointAt(r.lastIndex)>0xffff?2:1;}parentPort.postMessage({offsets,truncated});});`, { eval: true, workerData: { source, flags }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  worker.unref();
  let failure: unknown; let pending: { resolve: (value: SearchMatches) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout } | undefined;
  const fail = (error: unknown): void => {
    failure ??= error; void worker.terminate();
    if (pending) { clearTimeout(pending.timer); pending.reject(failure); pending = undefined; }
  };
  worker.on('message', (value: SearchMatches) => { if (!pending) return; clearTimeout(pending.timer); const { resolve } = pending; pending = undefined; resolve(value); });
  worker.once('error', fail);
  worker.once('exit', () => fail(new AppError('unavailable')));
  const run = (text: string): Promise<SearchMatches> => {
    if (failure) return Promise.reject(failure);
    if (pending) return Promise.reject(new AppError('conflict'));
    const { promise, resolve, reject } = Promise.withResolvers<SearchMatches>();
    pending = { resolve, reject, timer: setTimeout(() => fail(new AppError('too_large', 'search_regex_slow')), REGEX_MS) };
    worker.postMessage(text);
    return promise;
  };
  return {
    match: text => lineMatch(text, run),
    close() { failure ??= new AppError('unavailable'); void worker.terminate(); },
  };
}

/** Matches `text` with CRLF read as LF; offsets refer to `text` (a match ending at a line break spans the whole CRLF). */
async function lineMatch(text: string, run: (lf: string) => SearchMatches | Promise<SearchMatches>): Promise<SearchMatches> {
  if (!text.includes('\r\n')) return run(text);
  // LF positions (in the LF text) that were CRLF in the original.
  const breaks: number[] = []; let lf = '';
  for (let from = 0, removed = 0; ;) {
    const at = text.indexOf('\r\n', from);
    if (at < 0) { lf += text.slice(from); break; }
    lf += text.slice(from, at); breaks.push(at - removed); removed++; from = at + 1;
  }
  const result = await run(lf);
  const map = (offset: number): number => { let low = 0, high = breaks.length; while (low < high) { const mid = (low + high) >> 1; if (breaks[mid]! < offset) low = mid + 1; else high = mid; } return offset + low; };
  return { offsets: result.offsets.map(([start, end]) => [map(start), map(end)]), truncated: result.truncated };
}

function literal(text: string, source: string, options: SearchOptions): SearchMatches {
  const matcher = new RegExp(source, options.caseSensitive ? 'gu' : 'giu'); const offsets: [number, number][] = [];
  for (const match of text.matchAll(matcher)) {
    const start = match.index; const end = start + match[0].length;
    if (offsets.length === MAX_MATCHES) return { offsets, truncated: true };
    offsets.push([start, end]);
  }
  return { offsets, truncated: false };
}
