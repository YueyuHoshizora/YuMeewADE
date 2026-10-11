import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from './projects.ts';
import { TaskLedger } from './tasks.ts';

test('期限與標籤往返、更新保留正文、清除與驗證', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws);
  const task = await ledger.create('P', { title: 'T', due: '2028-02-29', tags: ['a', 'a', '中文字'], steps: ['keep'] });
  assert.equal(task.due, '2028-02-29'); assert.deepEqual(task.tags, ['a', '中文字']);
  const updated = await ledger.update('P', task.id, { due: '2026-12-01', tags: ['new'] });
  assert.deepEqual(updated.steps, [{ text: 'keep', done: false }]);
  assert.equal(updated.due, '2026-12-01'); assert.deepEqual(updated.tags, ['new']);
  for (const due of ['2027-02-29', '2026-13-01', '2026-1-01', '0000-01-01', 123]) await assert.rejects(ledger.update('P', task.id, { due: due as string }));
  for (const tags of [[''], [' x'], ['x\n'], Array(33).fill('x'), [2], 'x']) await assert.rejects(ledger.create('P', { title: 'T', tags: tags as string[] }));
  const cleared = await ledger.update('P', task.id, { due: '', tags: [] });
  assert.equal(cleared.due, ''); assert.deepEqual(cleared.tags, []);
}));
test('人工檔案錯誤 metadata 忽略', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  await fs.writeFile(ws.taskFile('P', task.id), '---\ntitle: T\ndue: 2026-02-30\ntags: [good, 42, "", " leading", good]\n---\nbody\n');
  const read = await ledger.get('P', task.id);
  assert.equal(read.due, ''); assert.deepEqual(read.tags, ['good']);
}));

test('標籤原子增刪、冪等與上限', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws);
  const task = await ledger.create('P', { title: 'T' });
  await Promise.all(['a', 'b'].map(tag => ledger.update('P', task.id, {}, { tag, add: true })));
  assert.deepEqual((await ledger.get('P', task.id)).tags?.sort(), ['a', 'b']);
  await ledger.update('P', task.id, {}, { tag: 'a', add: true });
  await ledger.update('P', task.id, {}, { tag: 'a', add: false });
  await ledger.update('P', task.id, {}, { tag: 'a', add: false });
  assert.deepEqual((await ledger.get('P', task.id)).tags, ['b']);
  await assert.rejects(ledger.update('P', task.id, {}, { tag: ' bad', add: true }));
  const full = Array.from({ length: 32 }, (_, i) => `tag${i}`);
  await ledger.update('P', task.id, { tags: full });
  await ledger.update('P', task.id, {}, { tag: 'tag0', add: true });
  await assert.rejects(ledger.update('P', task.id, {}, { tag: 'overflow', add: true }));
  assert.deepEqual((await ledger.get('P', task.id)).tags, full);
}));
