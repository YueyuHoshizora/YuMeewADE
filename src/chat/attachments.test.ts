import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { saveUpload, uploadPath } from './attachments.ts';

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
