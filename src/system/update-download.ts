import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpdateInfo } from '../shared/types.ts';
import type { UpdateDownloadResult } from '../shared/update-types.ts';
import { AppError } from '../shared/errors.ts';
import { openPath } from './open.ts';

const exec = promisify(execFile);
const MAX = 2 * 1024 ** 3;
export const UPDATE_METADATA = 'update-integrity.json';
export interface UpdateTrust { publicKey?: string; macTeamId?: string; windowsThumbprint?: string }
export interface IntegrityManifest { version: string; assets: { name: string; size: number; sha256: string }[]; signature?: string }
export function manifestPayload(manifest: IntegrityManifest): string {
  return JSON.stringify({ version: manifest.version, assets: [...manifest.assets].sort((a, b) => a.name.localeCompare(b.name, 'en')) });
}
export function parseManifest(text: string, version: string): IntegrityManifest {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== version || !('assets' in value) || !Array.isArray(value.assets) || value.assets.length > 30) throw new Error('Invalid metadata');
  const assets: IntegrityManifest['assets'] = [];
  for (const entry of value.assets) {
    if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string' || !/^[A-Za-z0-9_. -]{1,180}$/.test(entry.name) || entry.name.includes('..') || !('size' in entry) || !Number.isSafeInteger(entry.size) || typeof entry.size !== 'number' || entry.size <= 0 || entry.size > MAX || !('sha256' in entry) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || assets.some(a => a.name === entry.name)) throw new Error('Invalid metadata');
    assets.push({ name: entry.name, size: entry.size, sha256: entry.sha256 });
  }
  const signature = 'signature' in value && typeof value.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value.signature) ? value.signature : undefined;
  return { version, assets, ...(signature ? { signature } : {}) };
}
export function publisherSignature(manifest: IntegrityManifest, key?: string): boolean {
  if (!key || !manifest.signature) return false;
  try {
    const publicKey = createPublicKey(key);
    return publicKey.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(manifestPayload(manifest)), publicKey, Buffer.from(manifest.signature, 'base64'));
  } catch { return false; }
}
export function releaseURL(repo: string, version: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^\d+\.\d+\.\d+$/.test(version) || !/^[A-Za-z0-9_. -]{1,180}$/.test(name) || name.includes('..')) throw new Error('Invalid release');
  return `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`;
}
export async function releaseResponse(url: string, fetcher: typeof fetch = fetch): Promise<Response> {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new Error('Untrusted download host');
    const response = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next) throw new Error('Invalid redirect');
      current = new URL(next, current).href; continue;
    }
    if (!response.ok || !response.body) throw new Error('Download failed');
    return response;
  }
  throw new Error('Too many redirects');
}
async function boundedText(response: Response): Promise<string> {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body!) { size += chunk.length; if (size > 64 * 1024) throw new Error('Metadata too large'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
interface Stored { result: UpdateDownloadResult; file: string; sha256: string; signed: boolean }
export class UpdateDownloads {
  private directory: string | undefined;
  private busy = false;
  private closed = false;
  private stored: Stored | undefined;
  private readonly latest: () => UpdateInfo | undefined;
  private readonly repo: string;
  private readonly trust: UpdateTrust;
  private readonly fetcher: typeof fetch;
  constructor(latest: () => UpdateInfo | undefined, repo: string, trust: UpdateTrust = {}, fetcher: typeof fetch = fetch) { this.latest = latest; this.repo = repo; this.trust = trust; this.fetcher = fetcher; }
  async download(version: string, name: string): Promise<UpdateDownloadResult> {
    if (this.busy || this.closed) throw new AppError('conflict');
    const latest = this.latest(); const asset = latest?.assets.find(a => a.name === name);
    if (!latest || latest.version !== version || !asset) throw new AppError('bad_request');
    this.busy = true;
    let directory: string | undefined;
    try {
      const metadata = parseManifest(await boundedText(await releaseResponse(releaseURL(this.repo, version, UPDATE_METADATA), this.fetcher)), version);
      const entry = metadata.assets.find(a => a.name === name);
      if (!entry || entry.size !== asset.size) throw new Error('Missing checksum');
      directory = await mkdtemp(path.join(tmpdir(), 'yumeewade-update-'));
      const temporary = path.join(directory, 'download.part'); const file = path.join(directory, name);
      const handle = await open(temporary, 'wx', 0o600); const hash = createHash('sha256'); let size = 0;
      try {
        const response = await releaseResponse(releaseURL(this.repo, version, name), this.fetcher);
        for await (const chunk of response.body!) { size += chunk.length; if (size > entry.size || size > MAX || this.closed) throw new Error('Download exceeds limit'); hash.update(chunk); await handle.writeFile(chunk); }
        if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('Checksum mismatch');
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, file);
      const signed = publisherSignature(metadata, this.trust.publicKey);
      const platformTrusted = signed && asset.kind === 'installer' && await this.verifyPlatform(file);
      if (this.closed) throw new Error('Updater closed');
      const result: UpdateDownloadResult = { token: randomUUID(), name, integrity: true, publisherTrusted: platformTrusted, canLaunch: platformTrusted };
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
      this.directory = directory; this.stored = { file, result, signed, sha256: entry.sha256 }; return result;
    } catch (cause) { if (directory) await rm(directory, { recursive: true, force: true }); throw new AppError('internal', undefined, { cause }); }
    finally {
      this.busy = false;
      if (this.closed && this.directory) await rm(this.directory, { recursive: true, force: true });
    }
  }
  private async verifyPlatform(file: string): Promise<boolean> {
    try {
      if (process.platform === 'darwin' && this.trust.macTeamId && file.endsWith('.dmg')) {
        await exec('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', file], { timeout: 30_000, maxBuffer: 65536 });
        const { stdout, stderr } = await exec('/usr/bin/codesign', ['--display', '--verbose=4', file], { timeout: 30_000, maxBuffer: 65536 });
        return `${stdout}\n${stderr}`.split('\n').includes(`TeamIdentifier=${this.trust.macTeamId}`);
      }
      if (process.platform === 'win32' && /^[A-Fa-f0-9]{40}$/.test(this.trust.windowsThumbprint ?? '') && file.endsWith('.exe')) {
        const command = "$s=Get-AuthenticodeSignature -LiteralPath $env:YUMEEWADE_VERIFY_FILE; if($s.Status -ne 'Valid'){exit 1}; [Console]::Write($s.SignerCertificate.Thumbprint)";
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, YUMEEWADE_VERIFY_FILE: file }, timeout: 30_000, maxBuffer: 65536 });
        return stdout.trim().toUpperCase() === this.trust.windowsThumbprint?.toUpperCase();
      }
    } catch { return false; }
    return false;
  }
  async action(token: string, launch: boolean): Promise<void> {
    const stored = this.stored;
    if (this.closed || this.busy || !stored || stored.result.token !== token) throw new AppError('bad_request');
    this.busy = true;
    try {
      if (launch) {
        if (!stored.result.canLaunch || !stored.signed) throw new AppError('bad_request');
        const hash = createHash('sha256'); let size = 0;
        for await (const chunk of createReadStream(stored.file)) {
          size += chunk.length;
          if (size > MAX || this.closed) throw new AppError('bad_request');
          hash.update(chunk);
        }
        if (hash.digest('hex') !== stored.sha256 || !await this.verifyPlatform(stored.file) || this.closed) throw new AppError('bad_request');
        await openPath(stored.file);
      } else await openPath(stored.file, true);
    } catch (cause) { throw new AppError('internal', undefined, { cause }); }
    finally {
      this.busy = false;
      if (this.closed && this.directory) await rm(this.directory, { recursive: true, force: true });
    }
  }
  async close(): Promise<void> { this.closed = true; if (!this.busy && this.directory) await rm(this.directory, { recursive: true, force: true }); }
}
