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

test('舊規則的「已完成的工作」標題與範本空標題並存時合併讀取', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  await fs.writeFile(ws.taskFile('P', task.id), '---\ntitle: T\n---\n## 做了什麼\n\n## 下一步\n- go\n### 細節\n- sub\n## 已完成的工作\n- legacy\n');
  const sections = await ledger.sections('P', task.id);
  assert.deepEqual(sections.done, ['- legacy']);
  assert.deepEqual(sections.next, ['- go', '### 細節', '- sub']);
  // The one-line summary on the task drops the list marker; the record above keeps the raw line.
  assert.equal((await ledger.get('P', task.id)).next, 'go');
}));

test('沒指定階段的子作業沿用上層作業的階段，明確指定（含空字串）則照指定', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws);
  const parent = await ledger.create('P', { title: 'Parent', phase: '實作' });
  assert.equal((await ledger.create('P', { title: 'Child', parent: parent.id, kind: 'derived', derivedFrom: parent.id })).phase, '實作');
  assert.equal((await ledger.create('P', { title: 'Explicit', parent: parent.id, phase: '' })).phase, '');
  assert.equal((await ledger.create('P', { title: 'Top' })).phase, '');
}));

test('步驟改名保留勾選，移動時連同縮排子項目一起搬且不帶走區段尾端空行', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  await fs.writeFile(ws.taskFile('P', task.id), '---\ntitle: T\n---\n## 步驟\n- [x] A\n  - a detail\n- [ ] B\n\n## 下一步\n');
  await ledger.editStep('P', task.id, 0, 'A', 'A2');
  assert.deepEqual((await ledger.get('P', task.id)).steps, [{ text: 'A2', done: true }, { text: 'B', done: false }]);
  await ledger.moveStep('P', task.id, 1, 'B', -1);
  const body = (await fs.readFile(ws.taskFile('P', task.id), 'utf8')).split('---\n').at(-1);
  assert.equal(body, '## 步驟\n- [ ] B\n- [x] A2\n  - a detail\n\n## 下一步\n');
  await assert.rejects(ledger.moveStep('P', task.id, 0, 'B', -1));
  await assert.rejects(ledger.moveStep('P', task.id, 0, 'A2', 1), /step_changed|conflict|步驟/);
}));

test('備註超過上限時保留最新的 500 行', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  await fs.writeFile(ws.taskFile('P', task.id), `---\ntitle: T\n---\n## 備註\n${Array.from({ length: 520 }, (_, i) => `- m${i}`).join('\n')}\n`);
  const { memo } = await ledger.sections('P', task.id);
  assert.equal(memo.length, 500); assert.equal(memo[0], '- m20'); assert.equal(memo.at(-1), '- m519');
}));

test('作業標題在建立與改名時同樣以 300 字為上限', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws);
  await assert.rejects(ledger.create('P', { title: 'x'.repeat(301) }), /title|field_too_long|字/);
  const task = await ledger.create('P', { title: 'x'.repeat(300) });
  await assert.rejects(ledger.update('P', task.id, { title: 'y'.repeat(301) }));
  assert.equal((await ledger.update('P', task.id, { title: 'y'.repeat(300) })).title.length, 300);
}));
