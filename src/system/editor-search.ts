import { Worker } from 'node:worker_threads';
import { AppError } from '../shared/errors.ts';
export interface SearchOptions { page?: number; pageSize?: number; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; include?: string[]; exclude?: string[]; mode?: 'content' | 'files' }
export async function boundedMatches(text: string, query: string, options: SearchOptions): Promise<{ offsets: [number, number][]; truncated: boolean }> {
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Editor regex search is line-oriented: ^ and $ anchor each line, as in other IDE search panels.
  const flags = options.caseSensitive ? 'gmu' : 'gimu';
  try { new RegExp(source, flags); } catch { throw new AppError('bad_request'); }
  if (!options.regex) {
    const matcher = new RegExp(source, options.caseSensitive ? 'gu' : 'giu'); const offsets: [number, number][] = [];
    for (const match of text.matchAll(matcher)) {
      const start = match.index; const end = start + match[0].length;
      if (options.wholeWord && (start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1]!) || end < text.length && /[\p{L}\p{N}_]/u.test(text[end]!))) continue;
      if (offsets.length === 10000) return { offsets, truncated: true };
      offsets.push([start, end]);
    }
    return { offsets, truncated: false };
  }
  const worker = new Worker(`const {parentPort,workerData:d}=require('node:worker_threads');const r=new RegExp(d.source,d.flags);const offsets=[];let m;let truncated=false;while((m=r.exec(d.text))){const start=m.index,end=start+m[0].length;const word=c=>c!==undefined&&/[\\p{L}\\p{N}_]/u.test(c);if(!d.wholeWord||(!word(d.text[start-1])&&!word(d.text[end]))){if(offsets.length===10000){truncated=true;break;}offsets.push([start,end]);}if(!m[0].length)r.lastIndex++;}parentPort.postMessage({offsets,truncated});`, { eval: true, workerData: { text, source, flags, wholeWord: options.wholeWord }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  const { promise, resolve, reject } = Promise.withResolvers<{ offsets: [number, number][]; truncated: boolean }>();
  let settled = false;
  const finish = (error?: unknown, value?: { offsets: [number, number][]; truncated: boolean }): void => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); if (error) reject(error); else resolve(value!); };
  const timer = setTimeout(() => finish(new AppError('too_large')), 300);
  worker.once('message', value => finish(undefined, value)); worker.once('error', error => finish(error)); worker.once('exit', () => { if (!settled) finish(new AppError('unavailable')); });
  return promise;
}
