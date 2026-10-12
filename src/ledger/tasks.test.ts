import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from './projects.ts';
import { STEP_TEXT_MAX, STEPS_MAX, TaskLedger } from './tasks.ts';

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

test('建立作業時步驟數與每步長度有上限，邊界值可建立', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws);
  const atLimit = await ledger.create('P', { title: 'T', steps: [...Array.from({ length: STEPS_MAX - 1 }, (_, i) => `s${i}`), 'x'.repeat(STEP_TEXT_MAX)] });
  assert.equal(atLimit.steps.length, STEPS_MAX); assert.equal(atLimit.steps.at(-1)!.text.length, STEP_TEXT_MAX);
  await assert.rejects(ledger.create('P', { title: 'T', steps: Array.from({ length: STEPS_MAX + 1 }, (_, i) => `s${i}`) }));
  await assert.rejects(ledger.create('P', { title: 'T', steps: ['x'.repeat(STEP_TEXT_MAX + 1)] }));
  await assert.rejects(ledger.addStep('P', atLimit.id, 'one more'));
  assert.equal((await ledger.get('P', atLimit.id)).steps.length, STEPS_MAX);
}));

test('作業紀錄區段依別名讀取、略過空行與註解，行數與行長有上限', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  const long = 'x'.repeat(2500);
  await fs.writeFile(ws.taskFile('P', task.id), `---\ntitle: T\n---\n## Done\n- built it\n\n<!-- hint -->\n## 注意\n- ${long}\n## Next\n${Array.from({ length: 600 }, (_, i) => `- n${i}`).join('\n')}\n## 備註\n`);
  const sections = await ledger.sections('P', task.id);
  assert.deepEqual(sections.done, ['- built it']);
  assert.equal(sections.cautions[0]!.length, 2000);
  assert.equal(sections.next.length, 500); assert.equal(sections.next.at(-1), '- n499');
  assert.deepEqual(sections.memo, []);
  await assert.rejects(ledger.sections('P', '20990101-001'), /task_missing|not_found|作業/);
}));
