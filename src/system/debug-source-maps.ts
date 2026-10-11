import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInside } from '../shared/fsx.ts';
import { isLocalSecret } from '../git/git.ts';
import { AppError } from '../shared/errors.ts';

const MAX = 1_048_576;
export async function debugFile(root: string, relative: string): Promise<string> {
  if (!relative || relative.length > 4096 || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..' || p === '.git' || p === '.ai' || isLocalSecret(p))) throw new AppError('bad_request');
  root = await fs.realpath(root);
  let file = root;
  for (const part of relative.split('/')) { file = path.join(file, part); if ((await fs.lstat(file)).isSymbolicLink()) throw new AppError('bad_request'); }
  if (!isInside(root, await fs.realpath(file))) throw new AppError('bad_request');
  return file;
}
async function bounded(root: string, file: string): Promise<string> {
  const safe = await debugFile(root, path.relative(root, file).split(path.sep).join('/'));
  const handle = await fs.open(safe, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX) throw new AppError('bad_request'); const buffer = Buffer.alloc(stat.size + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > MAX) throw new AppError('bad_request'); return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); } finally { await handle.close(); }
}
export interface SourceSegment { generatedLine: number; generatedColumn: number; path: string; line: number; column: number }
export interface DebugSourceMap { segments: SourceSegment[]; sources: string[]; unmapped: { line: number; column: number }[] }
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decode(segment: string): number[] {
  const values: number[] = []; let value = 0; let shift = 0;
  for (const char of segment) { const digit = alphabet.indexOf(char); if (digit < 0 || shift > 30) throw new AppError('bad_request'); value += (digit & 31) * 2 ** shift; if (digit & 32) { shift += 5; continue; } const signed = value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2); if (!Number.isSafeInteger(signed)) throw new AppError('bad_request'); values.push(signed); value = 0; shift = 0; }
  if (shift || values.length > 5) throw new AppError('bad_request'); return values;
}
/** Flat Source Map v3 only. Never fetch URLs or expose sourcesContent. Unsupported/unsafe maps are ignored. */
export async function loadDebugSourceMap(root: string, script: string, reference: string): Promise<DebugSourceMap | undefined> {
  try {
    if (!reference || reference.length > MAX * 2) return undefined;
    script = await debugFile(root, path.relative(root, script).split(path.sep).join('/'));
    root = await fs.realpath(root);
    let base = path.dirname(script); let raw: string;
    if (reference.startsWith('data:application/json;base64,')) { const encoded = reference.slice(29); if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length > Math.ceil(MAX / 3) * 4) return undefined; raw = Buffer.from(encoded, 'base64').toString('utf8'); }
    else { if (/^[a-z][a-z0-9+.-]*:/iu.test(reference) && !reference.startsWith('file:')) return undefined; const mapFile = reference.startsWith('file:') ? fileURLToPath(reference) : path.resolve(base, decodeURIComponent(reference)); raw = await bounded(root, mapFile); base = path.dirname(mapFile); }
    if (Buffer.byteLength(raw) > MAX) return undefined;
    const map = JSON.parse(raw) as Record<string, unknown>;
    if (map.version !== 3 || map.sections !== undefined || !Array.isArray(map.sources) || map.sources.length > 256 || typeof map.mappings !== 'string' || map.mappings.length > MAX || (map.sourceRoot !== undefined && (typeof map.sourceRoot !== 'string' || map.sourceRoot.length > 4096))) return undefined;
    const sourceRoot = (map.sourceRoot as string | undefined) ?? '';
    if (/^[a-z][a-z0-9+.-]*:/iu.test(sourceRoot) || sourceRoot.includes('\0')) return undefined;
    if (map.sourcesContent !== undefined && (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length || map.sourcesContent.some(x => x !== null && (typeof x !== 'string' || Buffer.byteLength(x) > 262144)))) return undefined;
    const sources: string[] = [];
    for (const source of map.sources) { if (typeof source !== 'string' || source.length > 4096 || /^[a-z][a-z0-9+.-]*:/iu.test(source)) return undefined; const file = path.resolve(base, sourceRoot, decodeURIComponent(source)); const relative = path.relative(root, file).split(path.sep).join('/'); await debugFile(root, relative); sources.push(relative); }
    const segments: SourceSegment[] = []; const unmapped: { line: number; column: number }[] = []; let source = 0; let line = 0; let column = 0; let name = 0;
    const lines = map.mappings.split(';'); if (lines.length > 100000) return undefined;
    for (let generatedLine = 0; generatedLine < lines.length; generatedLine++) {
      let generatedColumn = 0;
      for (const part of lines[generatedLine]!.split(',')) {
        if (!part) continue;
        const values = decode(part); if (![1, 4, 5].includes(values.length) || values[0]! < 0) return undefined;
        generatedColumn += values[0]!;
        if (generatedColumn > 1000000 || segments.length + unmapped.length >= 65536) return undefined;
        if (values.length === 1) { unmapped.push({ line: generatedLine + 1, column: generatedColumn + 1 }); continue; }
        source += values[1]!; line += values[2]!; column += values[3]!;
        if (values.length === 5) name += values[4]!;
        if (!sources[source] || line < 0 || column < 0 || line > 1000000 || column > 1000000 || name < 0) return undefined;
        segments.push({ generatedLine: generatedLine + 1, generatedColumn: generatedColumn + 1, path: sources[source]!, line: line + 1, column: column + 1 });
      }
    }
    return { sources, segments, unmapped };
  } catch { return undefined; }
}
export function originalLocation(map: DebugSourceMap, line: number, column: number): SourceSegment | undefined {
  let best: SourceSegment | undefined;
  for (const segment of map.segments) if (segment.generatedLine === line && segment.generatedColumn <= column && (!best || segment.generatedColumn >= best.generatedColumn)) best = segment;
  if (best && map.unmapped.some(segment => segment.line === line && segment.column >= best!.generatedColumn && segment.column <= column)) return undefined;
  return best;
}
export function generatedLocation(map: DebugSourceMap, source: string, line: number): SourceSegment | undefined { return map.segments.find(s => s.path === source && s.line === line); }
