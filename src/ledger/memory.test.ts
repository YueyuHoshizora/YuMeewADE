import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { MemoryLedger, MEMORY_MAX_BYTES, MEMORY_MAX_FILES, validMemoryName } from './memory.ts';
import { ProjectLedger } from './projects.ts';

test('memory CRUD requires matching content revision and preserves AI edits', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const memory = new MemoryLedger(ws);
  assert.ok((await memory.list('P')).includes('INDEX.md'));
  const created = await memory.save('P', 'note.md', '# Note', null);
  assert.deepEqual(await memory.read('P', 'note.md'), created);
  await assert.rejects(memory.save('P', 'note.md', 'clobber', null), { status: 409 });
  const updated = await memory.save('P', 'note.md', '', created.revision);
  assert.notEqual(updated.revision, created.revision);
  const file = path.join(ws.projectDir('P'), '.ai', 'memory', 'note.md');
  await fs.writeFile(file, 'AI edit');
  await assert.rejects(memory.save('P', 'note.md', 'stale', updated.revision), { status: 409 });
  await assert.rejects(memory.remove('P', 'note.md', updated.revision), { status: 409 });
  assert.equal(await fs.readFile(file, 'utf8'), 'AI edit');
  await memory.remove('P', 'note.md', (await memory.read('P', 'note.md')).revision);
  await assert.rejects(memory.read('P', 'note.md'), { status: 404 });
  assert.ok(!(await memory.list('P')).includes('note.md'));
}));

test('memory names, byte caps, symlinks and missing projects fail closed', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' }); const memory = new MemoryLedger(ws);
  for (const name of ['../x.md', 'a/b.md', 'x.txt', '.md', 'CON.md', 'x.MD', '..md']) {
    assert.equal(validMemoryName(name), false, name);
    await assert.rejects(memory.save('P', name, '', null), { status: 400 });
  }
  await assert.rejects(memory.save('P', 'large.md', '字'.repeat(MEMORY_MAX_BYTES), null), { status: 400 });
  const dir = path.join(ws.projectDir('P'), '.ai', 'memory');
  await fs.writeFile(path.join(dir, 'large.md'), 'x'.repeat(MEMORY_MAX_BYTES + 1));
  await assert.rejects(memory.read('P', 'large.md'), { status: 400 });
  await fs.symlink(ws.projectFile('P'), path.join(dir, 'link.md'));
  assert.ok(!(await memory.list('P')).includes('link.md'));
  await assert.rejects(memory.read('P', 'link.md'), { status: 400 });
  await assert.rejects(memory.save('P', 'link.md', 'bad', null), { status: 400 });
  await assert.rejects(memory.list('../escape'), { status: 400 });
  await assert.rejects(memory.list('Missing'));
  await fs.rename(dir, `${dir}-real`); await fs.symlink(`${dir}-real`, dir);
  await assert.rejects(memory.list('P'), { status: 400 });
}));

test('memory serializes competing UI writes and enforces file count', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' }); const memory = new MemoryLedger(ws);
  const note = await memory.save('P', 'race.md', 'before', null);
  const writes = await Promise.allSettled([memory.save('P', 'race.md', 'one', note.revision), memory.save('P', 'race.md', 'two', note.revision)]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  const dir = path.join(ws.projectDir('P'), '.ai', 'memory');
  for (const name of await memory.list('P')) await fs.unlink(path.join(dir, name));
  for (let i = 0; i < MEMORY_MAX_FILES; i++) await fs.writeFile(path.join(dir, `note${i}.md`), '');
  await assert.rejects(memory.save('P', 'overflow.md', '', null), { status: 409 });
}));
