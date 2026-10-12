import { AppError } from '../shared/errors.ts';
import type { EditorEncoding } from '../shared/editor-workbench.ts';
export type { EditorEncoding } from '../shared/editor-workbench.ts';
export function validateEncoding(value: unknown): EditorEncoding {
  if (typeof value !== 'string' || !['UTF8', 'UTF8-BOM', 'UTF16LE', 'UTF16BE'].includes(value)) throw new AppError('bad_request');
  return value as EditorEncoding;
}
export function detectEncoding(bytes: Uint8Array): EditorEncoding {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'UTF16LE';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'UTF16BE';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'UTF8-BOM';
  return 'UTF8';
}
export function decodeText(bytes: Uint8Array, encoding: EditorEncoding, start = true): string {
  const label = encoding === 'UTF16LE' ? 'utf-16le' : encoding === 'UTF16BE' ? 'utf-16be' : 'utf-8';
  try {
    const text = new TextDecoder(label, { fatal: true, ignoreBOM: !start }).decode(bytes);
    if (text.includes('\0')) throw new AppError('bad_request');
    return text;
  } catch { throw new AppError('bad_request'); }
}
export function encodeText(text: string, encoding: EditorEncoding, bom = true): Buffer {
  if (text.includes('\0') || !text.isWellFormed()) throw new AppError('bad_request');
  if (encoding === 'UTF8') return Buffer.from(text, 'utf8');
  if (encoding === 'UTF8-BOM') return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8');
  const body = Buffer.from(text, 'utf16le'); if (encoding === 'UTF16BE') body.swap16();
  return bom ? Buffer.concat([Buffer.from(encoding === 'UTF16BE' ? [0xfe, 0xff] : [0xff, 0xfe]), body]) : body;
}
