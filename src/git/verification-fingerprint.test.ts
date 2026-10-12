import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verificationFingerprint } from './verification-fingerprint.ts';
import { parseVerificationInputModel } from '../shared/verification.ts';

test('declared outputs excluded; content and model changes invalidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-inputs-'));
  try {
    await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'dist'));
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'one');
    await fs.writeFile(path.join(root, 'dist', 'a.js'), 'generated');
    const model = { inputs: ['src/**'], outputs: ['dist/**'] };
    const before = await verificationFingerprint(root, 'config', model);
    await fs.writeFile(path.join(root, 'dist', 'a.js'), 'changed');
    assert.equal(await verificationFingerprint(root, 'config', model), before);
    const timestamp = (await fs.stat(path.join(root, 'src', 'a.ts'))).mtime;
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'two');
    await fs.utimes(path.join(root, 'src', 'a.ts'), timestamp, timestamp);
    assert.notEqual(await verificationFingerprint(root, 'config', model), before);
    assert.notEqual(await verificationFingerprint(root, 'changed config', model), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unsafe patterns rejected and overlapping inputs take precedence', async () => {
  for (const pattern of ['../outside', '/tmp/file', 'a/../../b', '.git/**', 'a\\b', '**x']) assert.throws(() => parseVerificationInputModel({ outputs: [pattern] }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-overlap-'));
  try {
    await fs.writeFile(path.join(root, 'a.ts'), 'first');
    const model = { inputs: ['**/*.ts'], outputs: ['**'] };
    const before = await verificationFingerprint(root, '', model);
    await fs.writeFile(path.join(root, 'a.ts'), 'other');
    assert.notEqual(await verificationFingerprint(root, '', model), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('symlink input content cannot be hidden by declared outputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-links-'));
  try {
    await fs.writeFile(path.join(root, 'generated.txt'), 'first');
    await fs.symlink('generated.txt', path.join(root, 'input.txt'));
    const model = { inputs: ['input.txt'], outputs: ['generated.txt'] };
    const before = await verificationFingerprint(root, '', model);
    await fs.writeFile(path.join(root, 'generated.txt'), 'other');
    assert.notEqual(await verificationFingerprint(root, '', model), before);
    await fs.symlink(os.tmpdir(), path.join(root, 'outside.txt'));
    await assert.rejects(verificationFingerprint(root, '', { inputs: ['outside.txt'] }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a main folder's own .ai/verification files are content; only the ledger's .ai is skipped", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'verify-ai-')));
  try {
    await fs.mkdir(path.join(root, '.ai', 'verification'), { recursive: true });
    const file = path.join(root, '.ai', 'verification', 'source.json');
    await fs.writeFile(file, '{"a":1}');
    for (const model of [undefined, { inputs: ['.ai/**'] }]) {
      const before = await verificationFingerprint(root, '', model);
      await fs.writeFile(file, `{"a":${Math.random()}}`);
      assert.notEqual(await verificationFingerprint(root, '', model), before, JSON.stringify(model));
    }
    // When the root is the ledger folder itself, its .ai bookkeeping is passed as ledgerData and ignored.
    const ledger = path.join(root, '.ai');
    const before = await verificationFingerprint(root, '', undefined, ledger);
    await fs.writeFile(file, '{"b":2}');
    assert.equal(await verificationFingerprint(root, '', undefined, ledger), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
