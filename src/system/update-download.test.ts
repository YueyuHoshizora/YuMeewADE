import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { UpdateDownloads, manifestPayload, parseManifest, publisherSignature, releaseResponse, releaseURL, type IntegrityManifest } from './update-download.ts';
import type { UpdateInfo } from '../shared/types.ts';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = 'YueyuHoshizora/YuMeewADE';
const name = 'YuMeewADE.Setup.1.2.0.exe';
const bytes = Buffer.from('verified artifact');
const metadata: IntegrityManifest = { version: '1.2.0', assets: [{ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
const info: UpdateInfo = { version: '1.2.0', tag: 'v1.2.0', url: '', notes: '', assets: [{ name, size: bytes.length, url: 'https://attacker.example/ignored', kind: 'installer' }] };

test('only an independently pinned publisher key authenticates metadata; tampering fails', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signed = { ...metadata, signature: sign(null, Buffer.from(manifestPayload(metadata)), privateKey).toString('base64') };
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(publisherSignature(signed), false);
  assert.equal(publisherSignature(signed, pem), true);
  assert.equal(publisherSignature({ ...signed, version: '2.0.0' }, pem), false);
  assert.throws(() => parseManifest(JSON.stringify({ ...metadata, assets: [{ ...metadata.assets[0], name: '../escape.exe' }] }), '1.2.0'));
  assert.throws(() => parseManifest(JSON.stringify(metadata), '2.0.0'));
  assert.throws(() => releaseURL(repo, '1.2.0', '../escape.exe'));
});

test('redirects reject HTTP and foreign hosts before making a second request', async () => {
  for (const location of ['http://github.com/file', 'https://attacker.example/file', 'https://github.com:444/file']) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location } }); };
    await assert.rejects(releaseResponse(releaseURL(repo, '1.2.0', name), fetcher));
    assert.equal(calls, 1);
  }
});

test('integrity-only download succeeds without trusting or executing the publisher', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async input => { urls.push(String(input)); return new Response(String(input).endsWith('.json') ? JSON.stringify(metadata) : bytes); };
  const downloads = new UpdateDownloads(() => info, repo, {}, fetcher);
  try {
    const result = await downloads.download('1.2.0', name);
    assert.equal(result.integrity, true); assert.equal(result.publisherTrusted, false); assert.equal(result.canLaunch, false);
    assert.equal(urls[1], releaseURL(repo, 'v1.2.0', name));
    await assert.rejects(downloads.action(result.token, true));
    await assert.rejects(downloads.action('unknown', false));
    await assert.rejects(downloads.download('1.1.0', name));
    await assert.rejects(downloads.download('1.2.0', '../escape.exe'));
  } finally { await downloads.close(); }
});

test('a release tagged without the v prefix downloads from its own tag', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async input => { urls.push(String(input)); return new Response(String(input).endsWith('.json') ? JSON.stringify(metadata) : bytes); };
  const downloads = new UpdateDownloads(() => ({ ...info, tag: '1.2.0' }), repo, {}, fetcher);
  try {
    assert.equal((await downloads.download('1.2.0', name)).integrity, true);
    assert.deepEqual(urls, [`https://github.com/${repo}/releases/download/1.2.0/update-integrity.json`, `https://github.com/${repo}/releases/download/1.2.0/${name}`]);
  } finally { await downloads.close(); }
});

test('checksum mismatch, truncated and oversized downloads never yield a launch token', async () => {
  for (const content of [Buffer.from('x'), Buffer.alloc(bytes.length), Buffer.alloc(bytes.length + 1)]) {
    const fetcher: typeof fetch = async input => new Response(String(input).endsWith('.json') ? JSON.stringify(metadata) : content);
    const downloads = new UpdateDownloads(() => info, repo, {}, fetcher);
    try { await assert.rejects(downloads.download('1.2.0', name)); }
    finally { await downloads.close(); }
  }
});

for (const stage of ['metadata', 'asset']) {
  test(`close aborts stalled ${stage} transfers and awaits partial-file cleanup`, { timeout: 5_000 }, async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const before = new Set(await fs.readdir(os.tmpdir()));
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      if (stage === 'asset' && String(input).endsWith('.json')) return new Response(JSON.stringify(metadata));
      const signal = init?.signal;
      assert.ok(signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          if (stage === 'asset') controller.enqueue(bytes.subarray(0, 1));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      started.resolve(signal);
      return new Response(body);
    };
    const downloads = new UpdateDownloads(() => info, repo, {}, fetcher);
    const outcome = downloads.download('1.2.0', name).then(() => 'fulfilled', () => 'rejected');
    const signal = await started.promise;
    let directories: string[] = [];
    try {
      if (stage === 'asset') {
        directories = (await fs.readdir(os.tmpdir())).filter(entry => entry.startsWith('yumeewade-update-') && !before.has(entry));
        assert.equal(directories.length, 1);
        assert.deepEqual(await fs.readdir(path.join(os.tmpdir(), directories[0]!)), ['download.part']);
      }
      await downloads.close();
      assert.equal(signal.aborted, true);
      assert.equal(await outcome, 'rejected');
      for (const directory of directories) await assert.rejects(fs.stat(path.join(os.tmpdir(), directory)), { code: 'ENOENT' });
      await assert.rejects(downloads.download('1.2.0', name));
    } finally {
      if (!signal.aborted) streamController?.error(new Error('Test cleanup'));
      await outcome;
      await downloads.close();
    }
  });
}
