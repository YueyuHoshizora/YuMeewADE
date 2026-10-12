import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { WorktreeService } from '../git/worktree.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { EditorService } from './editor.ts';
import { encodeText, type EditorEncoding } from './editor-encoding.ts';

async function fixture(ws: Parameters<Parameters<typeof withTmpWorkspace>[0]>[0], bodyBytes?: number) {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: 100000 });
  return { editor: new EditorService(worktree, tasks, {}, bodyBytes), root: ws.projectDir('P') };
}

for (const encoding of ['UTF8', 'UTF8-BOM', 'UTF16LE', 'UTF16BE'] as EditorEncoding[]) {
  test(`editor preserves ${encoding} through save, apply, history and deleted-file restoration`, () => withTmpWorkspace(async ws => {
    const { editor, root } = await fixture(ws); const file = path.join(root, 'text.txt');
    try {
      await fs.writeFile(file, encodeText('語😀 before', encoding));
      const original = await editor.read('P', '', 'text.txt');
      assert.equal(original.binary, false); assert.equal(original.encoding, encoding); assert.equal(original.text, '語😀 before');
      const saved = await editor.save('P', '', original.path, '語😀 after', original.revision);
      assert.deepEqual(await fs.readFile(file), encodeText('語😀 after', encoding));
      const applied = await editor.apply('P', '', [{ path: original.path, revision: saved.revision, text: 'applied' }]);
      assert.deepEqual(await fs.readFile(file), encodeText('applied', encoding));
      const { entries } = await editor.history('P', '', original.path);
      const restored = await editor.restoreHistory('P', '', original.path, entries.find(entry => entry.text === original.text)!.id, applied[0]!.revision);
      assert.deepEqual(await fs.readFile(file), encodeText(original.text, encoding));
      await editor.mutate('P', '', { action: 'delete', path: original.path, confirmation: original.path, revision: restored.revision });
      const deleted = await editor.history('P', '', original.path);
      await editor.restoreHistory('P', '', original.path, deleted.entries[0]!.id, 'missing');
      assert.deepEqual(await fs.readFile(file), encodeText(original.text, encoding));
    } finally { editor.dispose(); }
  }));
}

test('encoding-only save converts bytes and aggregate apply budget rejects atomically', () => withTmpWorkspace(async ws => {
  const { editor, root } = await fixture(ws, 16384);
  try {
    await fs.writeFile(path.join(root, 'one.txt'), 'same'); await fs.writeFile(path.join(root, 'two.txt'), 'other');
    const original = await editor.read('P', '', 'one.txt');
    const converted = await editor.save('P', '', original.path, original.text, original.revision, 'UTF16BE');
    assert.deepEqual(await fs.readFile(path.join(root, 'one.txt')), encodeText('same', 'UTF16BE'));
    const second = await editor.read('P', '', 'two.txt');
    await assert.rejects(editor.apply('P', '', [{ path: original.path, revision: converted.revision, text: 'a'.repeat(5000) }, { path: second.path, revision: second.revision, text: 'b'.repeat(5000) }]), { code: 'too_large' });
    assert.deepEqual(await fs.readFile(path.join(root, 'one.txt')), encodeText('same', 'UTF16BE')); assert.equal(await fs.readFile(path.join(root, 'two.txt'), 'utf8'), 'other');
  } finally { editor.dispose(); }
}));

test('large-file segment CAS includes bytes outside preview; patch and range recovery retain suffix and mode', () => withTmpWorkspace(async ws => {
  const { editor, root } = await fixture(ws); const file = path.join(root, 'large.txt');
  try {
    const initial = Buffer.from('a'.repeat(3 * 1024 * 1024) + '終😀tail'); await fs.writeFile(file, initial); await fs.chmod(file, 0o751);
    const segment = await editor.segment('P', '', 'large.txt', 2200000, 16);
    const external = await fs.open(file, 'r+'); try { await external.write(Buffer.from('b'), 0, 1, 2800000); } finally { await external.close(); }
    await assert.rejects(editor.segmentPatch('P', '', 'large.txt', segment.offset, segment.end, 'replacement', segment.revision, segment.encoding), { code: 'conflict' });
    const before = await fs.readFile(file); const current = await editor.segment('P', '', 'large.txt', segment.offset, 16);
    const patched = await editor.segmentPatch('P', '', 'large.txt', current.offset, current.end, '語😀', current.revision, current.encoding);
    assert.equal(patched.end, current.offset + Buffer.byteLength('語😀')); assert.equal(patched.text, '語😀');
    assert.deepEqual(await fs.readFile(file), Buffer.concat([before.subarray(0, current.offset), Buffer.from('語😀'), before.subarray(current.end)]));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o751);
    const history = await editor.history('P', '', 'large.txt'); assert.deepEqual({ ...history.entries[0]!.range, sha256: undefined }, { offset: current.offset, end: patched.end, sha256: undefined });
    await editor.restoreHistory('P', '', 'large.txt', history.entries[0]!.id, patched.revision); assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.editor-')), false);
  } finally { editor.dispose(); }
}));

test('an older segment edit cannot be restored over bytes a later edit moved or changed', () => withTmpWorkspace(async ws => {
  const { editor, root } = await fixture(ws); const file = path.join(root, 'a.txt');
  try {
    await fs.writeFile(file, 'abcdef');
    let doc = await editor.read('P', '', 'a.txt');
    await editor.segmentPatch('P', '', 'a.txt', 0, 1, 'XYZ', doc.revision, 'UTF8');
    const older = (await editor.history('P', '', 'a.txt')).entries[0]!;
    doc = await editor.read('P', '', 'a.txt');
    await editor.segmentPatch('P', '', 'a.txt', 0, 3, 'Q', doc.revision, 'UTF8');
    doc = await editor.read('P', '', 'a.txt'); assert.equal(doc.text, 'Qbcdef');
    // The older entry's offsets (0..3) now cover "Qbc": restoring them would silently drop "bc".
    await assert.rejects(editor.restoreHistory('P', '', 'a.txt', older.id, doc.revision), { code: 'conflict' });
    assert.equal(await fs.readFile(file, 'utf8'), 'Qbcdef');
    const newest = (await editor.history('P', '', 'a.txt')).entries[0]!;
    await editor.restoreHistory('P', '', 'a.txt', newest.id, doc.revision);
    assert.equal(await fs.readFile(file, 'utf8'), 'XYZbcdef', 'the latest edit still restores');
  } finally { editor.dispose(); }
}));

for (const encoding of ['UTF8', 'UTF8-BOM', 'UTF16LE', 'UTF16BE'] as EditorEncoding[]) {
  test(`segment ${encoding} boundaries reject split characters and preserve BOM`, () => withTmpWorkspace(async ws => {
    const { editor, root } = await fixture(ws); const file = path.join(root, 'text.txt');
    try {
      const bytes = encodeText('😀hello語tail', encoding); await fs.writeFile(file, bytes);
      const start = encoding === 'UTF8' ? 0 : encoding === 'UTF8-BOM' ? 3 : 2;
      const segment = await editor.segment('P', '', 'text.txt', 0, 5); assert.ok(segment.end <= 5);
      await assert.rejects(editor.segmentPatch('P', '', 'text.txt', start + (encoding.startsWith('UTF16') ? 2 : 1), start + 4, '', segment.revision, encoding), { code: 'bad_request' });
      await assert.rejects(editor.segmentPatch('P', '', 'text.txt', start + 1, start + 1, 'x', segment.revision, encoding), { code: 'bad_request' });
      const patched = await editor.segmentPatch('P', '', 'text.txt', start, start + 4, '語', segment.revision, encoding);
      assert.deepEqual(await fs.readFile(file), encodeText('語hello語tail', encoding));
      const history = await editor.history('P', '', 'text.txt'); await editor.restoreHistory('P', '', 'text.txt', history.entries[0]!.id, patched.revision);
      assert.deepEqual(await fs.readFile(file), bytes);
    } finally { editor.dispose(); }
  }));
}

test('segment rejects binary bytes beyond preview, secret paths, symlinks and oversized files', () => withTmpWorkspace(async ws => {
  const { editor, root } = await fixture(ws);
  try {
    await fs.writeFile(path.join(root, 'binary.txt'), 'a'.repeat(3 * 1024 * 1024) + '\0');
    await assert.rejects(editor.segment('P', '', 'binary.txt', 0, 16), { code: 'bad_request' });
    await fs.writeFile(path.join(root, '.env'), 'secret'); await fs.symlink(path.join(root, 'binary.txt'), path.join(root, 'link.txt'));
    for (const name of ['.env', 'link.txt']) await assert.rejects(editor.segment('P', '', name, 0, 16), { code: 'not_found' });
    const huge = await fs.open(path.join(root, 'huge.txt'), 'w'); try { await huge.truncate(128 * 1024 * 1024 + 1); } finally { await huge.close(); }
    await assert.rejects(editor.segment('P', '', 'huge.txt', 0, 16), { code: 'too_large' });
  } finally { editor.dispose(); }
}));

test('multi-file drafts retain independent encodings and JSON-escaped body budgets', () => withTmpWorkspace(async ws => {
  const { editor, root } = await fixture(ws, 16384);
  try {
    await fs.writeFile(path.join(root, 'le.txt'), encodeText('left', 'UTF16LE'));
    await fs.writeFile(path.join(root, 'be.txt'), encodeText('right', 'UTF16BE'));
    const left = await editor.read('P', '', 'le.txt'); const right = await editor.read('P', '', 'be.txt');
    const saved = await editor.apply('P', '', [{ path: left.path, revision: left.revision, text: '左😀' }, { path: right.path, revision: right.revision, text: '右😀' }]);
    assert.deepEqual(await fs.readFile(path.join(root, 'le.txt')), encodeText('左😀', 'UTF16LE'));
    assert.deepEqual(await fs.readFile(path.join(root, 'be.txt')), encodeText('右😀', 'UTF16BE'));
    await assert.rejects(editor.save('P', '', left.path, '\n'.repeat(5000), saved[0]!.revision), { code: 'too_large' });
    assert.deepEqual(await fs.readFile(path.join(root, 'le.txt')), encodeText('左😀', 'UTF16LE'));
  } finally { editor.dispose(); }
}));

test('zero-length insertion and deletion return the precise editable range and undo without truncation', () => withTmpWorkspace(async ws => {
  const { editor, root } = await fixture(ws); const file = path.join(root, 'text.txt');
  try {
    await fs.writeFile(file, 'prefixsuffix');
    const current = await editor.segment('P', '', 'text.txt', 6, 6);
    const inserted = await editor.segmentPatch('P', '', 'text.txt', 6, 6, '語😀', current.revision, current.encoding);
    assert.equal(await fs.readFile(file, 'utf8'), 'prefix語😀suffix');
    assert.equal(inserted.end, 6 + Buffer.byteLength('語😀'));
    const deleted = await editor.segmentPatch('P', '', 'text.txt', inserted.offset, inserted.end, '', inserted.revision, inserted.encoding);
    assert.equal(deleted.end, deleted.offset); assert.equal(deleted.text, ''); assert.equal(await fs.readFile(file, 'utf8'), 'prefixsuffix');
    const history = await editor.history('P', '', 'text.txt');
    await editor.restoreHistory('P', '', 'text.txt', history.entries[0]!.id, deleted.revision);
    assert.equal(await fs.readFile(file, 'utf8'), 'prefix語😀suffix');
  } finally { editor.dispose(); }
}));
