import { promises as fs, constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.ts';
import { decodeText, detectEncoding, encodeText, type EditorEncoding } from './editor-encoding.ts';
import type { EditorSegment } from '../shared/editor-workbench.ts';
export type { EditorSegment } from '../shared/editor-workbench.ts';
async function header(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(Math.min(3, size)); let read = 0;
  while (read < bytes.length) { const result = await handle.read(bytes, read, bytes.length - read, read); if (!result.bytesRead) throw new AppError('conflict', 'editor_conflict'); read += result.bytesRead; }
  return bytes;
}
export async function readSegment(file: string, offset: number, length: number, revision: string, selected?: EditorEncoding): Promise<EditorSegment> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 4 || length > 262144) throw new AppError('bad_request');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 128 * 1024 * 1024 || offset > stat.size) throw new AppError('too_large');
    const head = await header(handle, stat.size); const encoding = selected ?? detectEncoding(head);
    const detected = detectEncoding(head);
    if (detected !== 'UTF8' && detected !== encoding) throw new AppError('bad_request');
    const bomSize = detected === 'UTF8-BOM' ? 3 : detected.startsWith('UTF16') ? 2 : 0;
    if (offset > 0 && offset < bomSize) throw new AppError('bad_request');
    if (encoding.startsWith('UTF16') && offset % 2 !== 0) throw new AppError('bad_request');
    const bytes = Buffer.alloc(Math.min(length, stat.size - offset)); let bytesRead = 0;
    while (bytesRead < bytes.length) { const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, offset + bytesRead); if (!read.bytesRead) throw new AppError('conflict', 'editor_conflict'); bytesRead += read.bytesRead; }
    let count = bytesRead; let text: string | undefined;
    for (let trim = 0; trim <= 3 && count >= 0; trim++, count--) { try { text = decodeText(bytes.subarray(0, count), encoding, offset === 0); break; } catch { if (offset + bytesRead === stat.size) throw new AppError('bad_request'); } }
    if (text === undefined || count === 0 && bytesRead > 0) throw new AppError('bad_request');
    const after = await handle.stat(); if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new AppError('conflict', 'editor_conflict');
    return { text, revision, offset, end: offset + count, size: stat.size, encoding };
  } finally { await handle.close(); }
}
export async function patchSegment(file: string, offset: number, end: number, text: string, encoding: EditorEncoding, check: () => Promise<void>, preserve: (segment: { text: string; end: number; sha256: string }) => Promise<void>, expectedSha256?: string): Promise<void> {
  // The 256 KiB limit is on the encoded replacement (checked below); UTF-8 length is the wrong measure for UTF-16, where a
  // restored CJK segment is smaller than its UTF-8 form. Every encoding needs at least one byte per UTF-16 code unit.
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || end - offset > 262144 || text.length > 262144) throw new AppError('bad_request');
  if (encoding.startsWith('UTF16') && (offset % 2 !== 0 || end % 2 !== 0)) throw new AppError('bad_request');
  const source = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); const tmp = path.join(path.dirname(file), `.editor-${randomUUID()}.tmp`); let output;
  try {
    const stat = await source.stat(); if (!stat.isFile() || stat.size > 128 * 1024 * 1024 || end > stat.size) throw new AppError('too_large');
    const head = await header(source, stat.size); const detected = detectEncoding(head);
    if (detected !== 'UTF8' && detected !== encoding || offset === 0 && end < (detected === 'UTF8-BOM' ? 3 : detected.startsWith('UTF16') ? 2 : 0)) throw new AppError('bad_request');
    const bomSize = detected === 'UTF8-BOM' ? 3 : detected.startsWith('UTF16') ? 2 : 0;
    if (offset > 0 && offset < bomSize) throw new AppError('bad_request');
    const before = Buffer.alloc(end - offset); let read = 0;
    while (read < before.length) { const result = await source.read(before, read, before.length - read, offset + read); if (!result.bytesRead) throw new AppError('conflict', 'editor_conflict'); read += result.bytesRead; }
    // A history restore names the bytes it expects to replace; anything else there means later edits moved or changed them.
    if (expectedSha256 !== undefined && createHash('sha256').update(before).digest('hex') !== expectedSha256) throw new AppError('conflict', 'editor_conflict');
    // A BOM is written back only where the file has one: an unmarked UTF-16 file (encoding named, not detected) stays unmarked.
    const atBom = offset === 0 && bomSize > 0;
    const oldText = decodeText(before, encoding, atBom);
    const replacement = encodeText(text, encoding, atBom);
    if (replacement.length > 262144 || stat.size - before.length + replacement.length > 128 * 1024 * 1024) throw new AppError('too_large');
    // Both boundaries must also begin independently decodable characters.
    for (const boundary of new Set([offset, end])) {
      if (boundary >= stat.size) continue;
      const probe = Buffer.alloc(Math.min(4, stat.size - boundary)); let read = 0;
      while (read < probe.length) { const result = await source.read(probe, read, probe.length - read, boundary + read); if (!result.bytesRead) throw new AppError('conflict', 'editor_conflict'); read += result.bytesRead; }
      let valid = false;
      for (let size = probe.length; size > 0; size--) { try { decodeText(probe.subarray(0, size), encoding, boundary === 0); valid = true; break; } catch { /* partial next character */ } }
      if (!valid) throw new AppError('bad_request');
    }
    await check(); await preserve({ text: oldText, end: offset + replacement.length, sha256: createHash('sha256').update(replacement).digest('hex') });
    output = await fs.open(tmp, 'wx', stat.mode & 0o777); await output.chmod(stat.mode & 0o777); const chunk = Buffer.alloc(65536);
    const spans: [number, number][] = [[0, offset], [end, stat.size]];
    for (let index = 0; index < spans.length; index++) {
      const [start, stop] = spans[index]!;
      if (index === 1) await output.writeFile(replacement);
      let position = start; while (position < stop) { const count = Math.min(chunk.length, stop - position); const { bytesRead } = await source.read(chunk, 0, count, position); if (!bytesRead) throw new AppError('conflict', 'editor_conflict'); await output.writeFile(chunk.subarray(0, bytesRead)); position += bytesRead; }
    }
    await output.sync(); await output.close(); await check(); await fs.rename(tmp, file);
  } finally { await source.close(); await output?.close().catch(() => undefined); await fs.rm(tmp, { force: true }); }
}
