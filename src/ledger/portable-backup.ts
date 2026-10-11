import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../shared/errors.ts';

export const PORTABLE_LIMIT = 8 * 1024 ** 3;
const MAGIC = Buffer.from('YMAEBK01');
const invalid = () => new AppError('conflict', 'care_backup_invalid');
function key(password: string, salt: Buffer): Promise<Buffer> {
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new AppError('bad_request');
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, derived) => error ? reject(error) : resolve(derived));
  return promise;
}
function bound(): Transform { let bytes = 0; return new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; done(bytes > PORTABLE_LIMIT ? new AppError('too_large') : null, chunk); } }); }
interface Entry { name: string; kind: 'file' | 'directory' | 'link'; size: number; executable: boolean; target?: string }
function safe(name: string): boolean { return name.length > 0 && name.length <= 4096 && !name.includes('\\') && !/[\0\r\n:]/u.test(name) && !path.posix.isAbsolute(name) && name.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/^(credentials\.sqlite(?:[-.].*)?|credentials\.key|master\.key|core\.lock|cli-accounts|auth\.json|\.credentials\.json|\.device-keys\.json|antigravity-oauth-token)$/i.test(part)); }
export async function encryptSnapshot(folder: string, output: string, password: string): Promise<void> {
  const salt = randomBytes(16); const iv = randomBytes(12); const secret = await key(password, salt);
  const cipher = createCipheriv('aes-256-gcm', secret, iv); secret.fill(0);
  const header = Buffer.concat([MAGIC, salt, iv]); cipher.setAAD(header);
  const handle = await fs.open(output, 'wx', 0o600);
  try {
    await handle.write(header);
    let count = 0;
    async function* walk(file: string, name: string): AsyncGenerator<Buffer> {
      if (++count > 100000 || !safe(name)) throw invalid();
      const stat = await fs.lstat(file);
      const entry: Entry = { name, kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file', size: stat.isFile() ? stat.size : 0, executable: (stat.mode & 0o100) !== 0 };
      if (stat.isSymbolicLink()) entry.target = await fs.readlink(file);
      else if (!stat.isDirectory() && !stat.isFile()) throw invalid();
      const metadata = Buffer.from(JSON.stringify(entry)); const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length); yield length; yield metadata;
      if (stat.isFile()) { let size = 0; for await (const chunk of createReadStream(file)) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; yield bytes; } if (size !== stat.size) throw invalid(); }
      else if (stat.isDirectory()) for (const child of (await fs.readdir(file)).sort()) yield* walk(path.join(file, child), `${name}/${child}`);
    }
    async function* records() { for (const name of (await fs.readdir(folder)).sort()) yield* walk(path.join(folder, name), name); yield Buffer.alloc(4); }
    await pipeline(Readable.from(records()), bound(), cipher, createWriteStream(output, { flags: 'r+', start: header.length }));
    await handle.write(cipher.getAuthTag(), 0, 16, (await handle.stat()).size); await handle.sync();
    if ((await handle.stat()).size > PORTABLE_LIMIT) throw new AppError('too_large');
  } finally { await handle.close(); }
}
export async function receiveEncrypted(input: AsyncIterable<Uint8Array>, encrypted: string): Promise<void> {
  await pipeline(Readable.from(input), bound(), createWriteStream(encrypted, { flags: 'wx', mode: 0o600 }));
}
export async function decryptSnapshot(encrypted: string, plain: string, folder: string, password: string): Promise<void> {
  const handle = await fs.open(encrypted, 'r');
  try {
    const size = (await handle.stat()).size; if (size < 56 || size > PORTABLE_LIMIT) throw invalid();
    const header = Buffer.alloc(36); const tag = Buffer.alloc(16); await handle.read(header, 0, 36, 0); await handle.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, 8).equals(MAGIC)) throw invalid();
    const secret = await key(password, header.subarray(8, 24)); const decipher = createDecipheriv('aes-256-gcm', secret, header.subarray(24)); secret.fill(0); decipher.setAAD(header); decipher.setAuthTag(tag);
    try { await pipeline(createReadStream(encrypted, { start: 36, end: size - 17 }), decipher, bound(), createWriteStream(plain, { flags: 'wx', mode: 0o600 })); } catch { throw invalid(); }
  } finally { await handle.close(); }
  // Only authenticated bytes are interpreted; links are materialized last, never traversed during extraction.
  const source = await fs.open(plain, 'r'); let position = 0; const length = (await source.stat()).size;
  const read = async (size: number): Promise<Buffer> => {
    if (position + size > length) throw invalid();
    const data = Buffer.alloc(size);
    for (let offset = 0; offset < size;) { const result = await source.read(data, offset, size - offset, position); if (result.bytesRead === 0) throw invalid(); offset += result.bytesRead; position += result.bytesRead; }
    return data;
  };
  const seen = new Set<string>(); const directories = new Set<string>(); const links: Entry[] = [];
  await fs.mkdir(folder, { mode: 0o700 });
  try {
    for (;;) {
      const size = (await read(4)).readUInt32BE(); if (size === 0) { if (position !== length) throw invalid(); break; } if (size > 16384 || seen.size >= 100000) throw invalid();
      const value: unknown = JSON.parse((await read(size)).toString('utf8'));
      if (!value || typeof value !== 'object') throw invalid(); const entry = value as Entry;
      if (typeof entry.name !== 'string' || !safe(entry.name) || seen.has(entry.name) || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.executable !== 'boolean') throw invalid();
      for (let parent = path.posix.dirname(entry.name); parent !== '.'; parent = path.posix.dirname(parent)) if (!directories.has(parent)) throw invalid();
      seen.add(entry.name); const target = path.join(folder, ...entry.name.split('/'));
      if (entry.kind === 'directory' && entry.size === 0) { await fs.mkdir(target, { mode: 0o700 }); directories.add(entry.name); }
      else if (entry.kind === 'link' && entry.size === 0 && typeof entry.target === 'string') { const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.name), entry.target)); if (path.isAbsolute(entry.target) || entry.target.includes('\\') || /[\0\r\n]/u.test(entry.target) || !safe(resolved)) throw invalid(); links.push(entry); }
      else if (entry.kind === 'file') { const file = await fs.open(target, 'wx', entry.executable ? 0o700 : 0o600); try { for (let left = entry.size; left > 0;) { const bytes = await read(Math.min(left, 65536)); await file.writeFile(bytes); left -= bytes.length; } } finally { await file.close(); } }
      else throw invalid();
    }
    for (const entry of links) { const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.name), entry.target!)); if (!seen.has(resolved)) throw invalid(); await fs.symlink(entry.target!, path.join(folder, ...entry.name.split('/'))); }
  } finally { await source.close(); }
}
