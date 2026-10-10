import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { attachImages, cleanupUploads, saveUpload, uploadPath, UPLOAD_TTL_MS } from './attachments.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { ChatStore } from './store.ts';

const signatures = {
  png: Buffer.from('89504e470d0a1a0a', 'hex'),
  jpg: Buffer.from('ffd8ff', 'hex'),
  jpeg: Buffer.from('ffd8ff', 'hex'),
  gif: Buffer.from('GIF89a'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
};

test('each supported image signature is accepted and stored unchanged', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  for (const [ext, signature] of Object.entries(signatures)) {
    const raw = Buffer.concat([signature, Buffer.alloc(16)]);
    const result = await saveUpload(ws, 'P', `image.${ext}`, raw);
    assert.deepEqual(await fs.readFile(uploadPath(ws, 'P', result.id)), raw);
    assert.equal(result.name, `image.${ext}`);
  }
  const oldGif = await saveUpload(ws, 'P', 'old.gif', Buffer.from('GIF87a'));
  assert.match(oldGif.id, /\.gif$/u);
}));

test('renamed text, mismatched images and short headers are rejected before writing', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  for (const [ext, signature] of Object.entries(signatures)) {
    for (const raw of [Buffer.from('plain text'), signature.subarray(0, signature.length - 1)]) {
      await assert.rejects(saveUpload(ws, 'P', `renamed.${ext}`, raw), { code: 'bad_request', field: 'name' });
    }
  }
  await assert.rejects(saveUpload(ws, 'P', 'wrong.png', signatures.jpg), { code: 'bad_request' });
  assert.deepEqual(await fs.readdir(ws.uploadsDir('P')), []);
}));

test('cleanup removes only expired unreferenced staged images', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T' });
  const store = new ChatStore(ws);
  const old = await saveUpload(ws, 'P', 'old.png', signatures.png);
  const recent = await saveUpload(ws, 'P', 'recent.png', signatures.png);
  const queued = await saveUpload(ws, 'P', 'queued.png', signatures.png);
  const attached = await saveUpload(ws, 'P', 'attached.png', signatures.png);
  const [attachment] = await attachImages(ws, 'P', task.id, [attached.id], 10);
  const now = Date.now();
  const expired = new Date(now - UPLOAD_TTL_MS - 1000);
  for (const file of [uploadPath(ws, 'P', old.id), uploadPath(ws, 'P', queued.id), attachment!]) await fs.utimes(file, expired, expired);
  await store.updateQueue('P', task.id, () => [{ id: 'q', text: 'image', ai: 'mock', at: '', images: [queued.id] }]);
  await cleanupUploads(ws, store, now);
  await assert.rejects(fs.access(uploadPath(ws, 'P', old.id)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(uploadPath(ws, 'P', recent.id)), signatures.png);
  assert.deepEqual(await fs.readFile(uploadPath(ws, 'P', queued.id)), signatures.png);
  assert.deepEqual(await fs.readFile(attachment!), signatures.png);
  await store.updateQueue('P', task.id, () => []);
  await cleanupUploads(ws, store, now);
  await assert.rejects(fs.access(uploadPath(ws, 'P', queued.id)), { code: 'ENOENT' });
}));
