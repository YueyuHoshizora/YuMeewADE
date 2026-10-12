import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { ChatStore } from './store.ts';
import { saveUpload, cleanupUploads, attachImages, uploadPath, UPLOAD_TTL_MS } from './attachments.ts';
import { addDraftImage, readDraft, updateDraft, draftImagePath, validateReviews } from './drafts.ts';
import { buildTaskContext, readSource, saveContext, validateContext } from './context.ts';
import { HANDOFF_NOTICE, inspectHandoff } from './prompt.ts';

test('draft references survive cleanup and attachment preparation until successful release', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  await new ProjectLedger(ws).create({ name: 'Other' });
  const task = await new TaskLedger(ws).create('P', { title: 'T' });
  for (const scope of [task.id, 'quickstart']) {
    const image = await saveUpload(ws, 'P', 'draft.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    await addDraftImage(ws, 'P', scope, image, 10);
    const expired = new Date(Date.now() - UPLOAD_TTL_MS - 1000);
    await fs.utimes(uploadPath(ws, 'P', image.id), expired, expired);
    await cleanupUploads(ws, new ChatStore(ws));
    assert.equal((await readDraft(ws, 'P', scope)).images[0]?.id, image.id);
    await attachImages(ws, 'P', task.id, [image.id], 10);
    assert.equal(await fs.readFile(await draftImagePath(ws, 'P', scope, image.id), 'hex'), '89504e470d0a1a0a');
    await assert.rejects(draftImagePath(ws, 'Other', scope, image.id), { code: 'not_found' });
    await updateDraft(ws, 'P', scope, draft => { draft.images = []; });
    await cleanupUploads(ws, new ChatStore(ws));
    await assert.rejects(fs.access(uploadPath(ws, 'P', image.id)), { code: 'ENOENT' });
  }
}));

test('an archived task draft no longer keeps its staged images forever; the draft forgets the expired ones', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const tasks = new TaskLedger(ws);
  const task = await tasks.create('P', { title: 'T' });
  const image = await saveUpload(ws, 'P', 'draft.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  await addDraftImage(ws, 'P', task.id, image, 10);
  const expired = new Date(Date.now() - UPLOAD_TTL_MS - 1000);
  await fs.utimes(uploadPath(ws, 'P', image.id), expired, expired);
  await tasks.archive('P', task.id);
  await cleanupUploads(ws, new ChatStore(ws));
  await assert.rejects(fs.access(uploadPath(ws, 'P', image.id)), { code: 'ENOENT' });
  const drafts = JSON.parse(await fs.readFile(path.join(ws.projectDir('P'), '.ai', 'drafts.json'), 'utf8')) as Record<string, { images: unknown[]; reviews: unknown[] }>;
  assert.deepEqual(drafts[task.id]?.images, []);
}));

test('a drafts file of the wrong shape is reported by name and keeps cleanup away from that project', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T' });
  const image = await saveUpload(ws, 'P', 'draft.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  await addDraftImage(ws, 'P', task.id, image, 10);
  const expired = new Date(Date.now() - UPLOAD_TTL_MS - 1000);
  await fs.utimes(uploadPath(ws, 'P', image.id), expired, expired);
  const file = path.join(ws.projectDir('P'), '.ai', 'drafts.json');
  // Valid JSON, wrong shape: the image reference can no longer be read, so the image might still be wanted.
  await fs.writeFile(file, JSON.stringify({ [task.id]: { images: image.id, reviews: [] } }));
  await assert.rejects(readDraft(ws, 'P', task.id), { detail: 'file_corrupt', field: 'drafts.json' });
  await assert.rejects(updateDraft(ws, 'P', task.id, () => {}), { detail: 'file_corrupt' });
  await cleanupUploads(ws, new ChatStore(ws));
  await fs.access(uploadPath(ws, 'P', image.id));
}));

test('source paths are read-only bounded and reject escape and symlink paths', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T' });
  const root = ws.projectDir('P');
  await fs.writeFile(path.join(root, 'guide.txt'), 'one\ntwo\nthree');
  const source = { path: 'guide.txt', start: 2, end: 3 };
  assert.equal(await readSource(root, source), '2: two\n3: three');
  await fs.symlink(path.join(root, 'guide.txt'), path.join(root, 'alias.txt'));
  await assert.rejects(readSource(root, { ...source, path: 'alias.txt' }), { code: 'bad_request' });
  assert.throws(() => validateContext({ decisions: '', sources: [{ ...source, path: '../guide.txt' }] }, 1000), { code: 'bad_request' });
  await saveContext(ws, 'P', task.id, { decisions: 'x'.repeat(500), sources: [source] });
  const context = await buildTaskContext(ws, 'P', task.id, root, 180);
  assert.equal(context.truncated, true); assert.ok(context.text.includes(HANDOFF_NOTICE)); assert.ok(context.text.length <= 180);
  assert.equal((await buildTaskContext(ws, 'P', task.id, root, 1)).text, '');
}));

test('secret and private-key files cannot be pinned, and one saved earlier is dropped instead of read', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T' });
  const root = ws.projectDir('P');
  for (const name of ['.envrc', '.envproduction', '.dev.varsproduction', '.ENV', 'keys/id_ecdsa', 'id_dsa', 'id_ed25519_sk', '.npmrc']) {
    assert.throws(() => validateContext({ decisions: '', sources: [{ path: name, start: 1, end: 1 }] }, 1000), { code: 'bad_request' }, name);
  }
  await fs.writeFile(path.join(root, '.envrc'), 'export API_TOKEN=PRIVATE');
  await fs.writeFile(path.join(root, 'guide.txt'), 'safe');
  // Saved before `.envrc` counted as a secret.
  await fs.mkdir(path.join(root, '.ai', 'chat'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai', 'chat', `${task.id}.context.json`), JSON.stringify({ decisions: '', sources: [{ path: '.envrc', start: 1, end: 1 }, { path: 'guide.txt', start: 1, end: 1 }], revision: 1 }));
  const context = await buildTaskContext(ws, 'P', task.id, root, 10_000);
  assert.ok(!context.text.includes('PRIVATE')); assert.ok(context.text.includes('safe'));
  assert.deepEqual(context.sources.map(source => source.path), ['guide.txt']);
}));

test('handoff exposes zero-based source indices without losing the authorization notice', () => {
  const rows = [{ at: 'a', role: 'user' as const, text: 'older', to: 'a', request: 'a' }, { at: 'b', role: 'user' as const, text: 'x'.repeat(1000), to: 'b', request: 'b' }];
  const preview = inspectHandoff(rows, 180, 40);
  assert.deepEqual(preview.rows, [41]); assert.equal(preview.start, 41); assert.equal(preview.truncated, true);
  assert.ok(preview.text.includes(HANDOFF_NOTICE)); assert.ok(preview.text.length <= 180);
});

test('review draft validation retains both old and new anchors and rejects path traversal', () => {
  const row = { path: 'src/a.ts', oldLine: 2, newLine: 3, hash: 'a'.repeat(64), code: 'value', comment: 'change' };
  assert.deepEqual(validateReviews([row]), [row]);
  assert.throws(() => validateReviews([{ ...row, path: '../a.ts' }]), { code: 'bad_request' });
});

test('review drafts persist independently of images and remain unchanged until successful clear', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const task = await new TaskLedger(ws).create('P', { title: 'T' });
  const review = { path: 'src/a.ts', oldLine: 1, newLine: 2, hash: 'a'.repeat(64), code: 'line', comment: 'fix' };
  await updateDraft(ws, 'P', task.id, draft => { draft.reviews = [review]; });
  assert.deepEqual((await readDraft(ws, 'P', task.id)).reviews, [review]);
  await assert.rejects(updateDraft(ws, 'P', task.id, () => { throw new Error('send failed'); }), /send failed/u);
  assert.deepEqual((await readDraft(ws, 'P', task.id)).reviews, [review]);
  await updateDraft(ws, 'P', task.id, draft => { draft.reviews = []; });
  assert.deepEqual((await readDraft(ws, 'P', task.id)).reviews, []);
}));
