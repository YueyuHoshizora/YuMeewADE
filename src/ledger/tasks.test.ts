import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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

test('作業紀錄裡程式碼區塊中的 ## 標題不切段；未收尾的區塊不吞掉後面的段落', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  await fs.writeFile(ws.taskFile('P', task.id), '---\ntitle: T\n---\n## 下一步\n```md\n## 注意\n```\n- real next\n## 注意\n- real caution\n## 備註\n````\n- memo\n');
  const sections = await ledger.sections('P', task.id);
  assert.deepEqual(sections.next, ['```md', '## 注意', '```', '- real next']);
  assert.deepEqual(sections.cautions, ['- real caution']);
  assert.deepEqual(sections.memo, ['````', '- memo']);
  await fs.writeFile(ws.taskFile('P', task.id), '---\ntitle: T\n---\n## 做了什麼\n```\n- cut off\n## 注意\n- still a caution\n');
  assert.deepEqual((await ledger.sections('P', task.id)).cautions, ['- still a caution']);
}));

test('同類標題重複時，作業摘要與紀錄讀到相同內容，新備註接在最後一個備註段', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  await fs.writeFile(ws.taskFile('P', task.id), '---\ntitle: T\n---\n## 下一步\n\n## 備註\n- old\n## Next\n- deploy\n## Memo\n- later\n');
  const read = await ledger.get('P', task.id);
  assert.equal(read.next, 'deploy'); assert.equal(read.memo, 'later');
  const appended = await ledger.appendMemo('P', task.id, 'newest');
  assert.match(appended.memo, /newest$/u);
  assert.match((await ledger.sections('P', task.id)).memo.at(-1)!, /newest$/u);
}));

test('omitted task phases stay unassigned in phased projects and child tasks; explicit phases round-trip without rewriting existing data', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P', phases: ['計畫', '實作'] });
  const ledger = new TaskLedger(ws);
  const parent = await ledger.create('P', { title: 'Parent', phase: '實作' });
  const projectBefore = await fs.readFile(ws.projectFile('P'), 'utf8');
  const parentBefore = await ledger.readRaw('P', parent.id);
  assert.equal((await ledger.create('P', { title: 'Child', parent: parent.id, kind: 'derived', derivedFrom: parent.id })).phase, '');
  assert.equal((await ledger.create('P', { title: 'Explicit', parent: parent.id, phase: '實作' })).phase, '實作');
  assert.equal((await ledger.create('P', { title: 'Cleared', parent: parent.id, phase: '' })).phase, '');
  assert.equal((await ledger.create('P', { title: 'Top' })).phase, '');
  await assert.rejects(ledger.create('P', { title: 'Invalid', phase: 42 as unknown as string }));
  assert.equal(await fs.readFile(ws.projectFile('P'), 'utf8'), projectBefore);
  assert.equal(await ledger.readRaw('P', parent.id), parentBefore);
}));

test('moving a task under its own descendant is refused, while other reparenting still works', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws);
  const a = await ledger.create('P', { title: 'A' });
  const b = await ledger.create('P', { title: 'B', parent: a.id });
  const c = await ledger.create('P', { title: 'C', parent: b.id });
  const other = await ledger.create('P', { title: 'Other' });
  for (const parent of [b.id, c.id]) await assert.rejects(ledger.update('P', a.id, { parent }), { status: 400, field: 'parent' });
  assert.equal((await ledger.get('P', a.id)).parent, '');
  // Concurrent moves that would only form a loop together: the project lock lets just one of them pass.
  const results = await Promise.allSettled([ledger.update('P', other.id, { parent: a.id }), ledger.update('P', a.id, { parent: other.id })]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await ledger.update('P', c.id, { parent: a.id })).parent, a.id);
}));

test('the newest task stays first after a day passes its 999th task id', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws);
  const first = await ledger.create('P', { title: 'first' });
  // Reserve up to …-998 the way earlier creations of the same day would have.
  const reservations = path.join(ws.internalDir, 'task-ids', 'P');
  await fs.writeFile(path.join(reservations, `${first.id.split('-')[0]}-998`), '');
  const older = await ledger.create('P', { title: 'older' }); const newer = await ledger.create('P', { title: 'newer' });
  assert.deepEqual([older.id.split('-')[1], newer.id.split('-')[1]], ['999', '1000']);
  assert.deepEqual((await ledger.list('P')).map(task => task.title), ['newer', 'older', 'first']);
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

test('nested steps move with their parent and only between siblings; fenced checklist examples are not steps', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  const body = async () => (await fs.readFile(ws.taskFile('P', task.id), 'utf8')).split('---\n').at(-1);
  await fs.writeFile(ws.taskFile('P', task.id), '---\ntitle: T\n---\n## 步驟\n- [ ] A\n  - [ ] A child\n  - [ ] A second\n- [ ] B\n');
  await ledger.moveStep('P', task.id, 3, 'B', -1);
  assert.equal(await body(), '## 步驟\n- [ ] B\n- [ ] A\n  - [ ] A child\n  - [ ] A second\n');
  await ledger.moveStep('P', task.id, 2, 'A child', 1);
  assert.equal(await body(), '## 步驟\n- [ ] B\n- [ ] A\n  - [ ] A second\n  - [ ] A child\n');
  // A child has no sibling outside its parent's list.
  await assert.rejects(ledger.moveStep('P', task.id, 2, 'A second', -1), { detail: 'field_type' });
  await assert.rejects(ledger.moveStep('P', task.id, 3, 'A child', 1), { detail: 'field_type' });
  await fs.writeFile(ws.taskFile('P', task.id), '---\ntitle: T\n---\n## 步驟\n- [x] real\n```md\n- [ ] example only\n```\n- [ ] after\n');
  assert.deepEqual((await ledger.get('P', task.id)).steps, [{ text: 'real', done: true }, { text: 'after', done: false }]);
  await ledger.setStep('P', task.id, 1, true, 'after');
  assert.equal(await body(), '## 步驟\n- [x] real\n```md\n- [ ] example only\n```\n- [x] after\n');
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

test('closed list-continuation fences never expose or edit example steps or headings', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  for (const indent of ['    ', '\t', '        ']) {
    for (const marker of ['```', '~~~~']) {
      const example = `${indent}${marker}md\n${indent}- [ ] example only\n## Memo\n${indent}${marker[0]!.repeat(marker.length + 1)}\n`;
      const body = `## Steps\n- [x] Implement\n${example}- [ ] Test\n`;
      await fs.writeFile(ws.taskFile('P', task.id), `---\ntitle: T\n---\n${body}`);
      assert.deepEqual((await ledger.get('P', task.id)).steps, [{ text: 'Implement', done: true }, { text: 'Test', done: false }]);
      await ledger.setStep('P', task.id, 1, true, 'Test');
      assert.equal((await ledger.readRaw('P', task.id)).split('---\n').at(-1), body.replace('- [ ] Test', '- [x] Test'));
      await assert.rejects(ledger.setStep('P', task.id, 1, true, 'example only'), { detail: 'step_changed' });
      await fs.writeFile(ws.taskFile('P', task.id), `---\ntitle: T\n---\n## Steps\n- [x] Implement\n${indent}${marker}md\n${indent}- [ ] unclosed example\n`);
      assert.deepEqual((await ledger.get('P', task.id)).steps, [{ text: 'Implement', done: true }, { text: 'unclosed example', done: false }]);
    }
  }
}));

test('task metadata, step and memo writes preserve CRLF style and untouched body bytes', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  const body = '## Steps\r\n- [ ] ship\r\n## Unknown\r\n\tkeep trailing  \r\n## Memo\r\n- old\r\n';
  await fs.writeFile(ws.taskFile('P', task.id), `---\r\ntitle: Original\r\n---\r\n${body}`);
  await ledger.update('P', task.id, { title: 'Renamed' });
  assert.equal((await ledger.readRaw('P', task.id)).split('---\r\n').at(-1), body);
  await ledger.setStep('P', task.id, 0, true, 'ship');
  assert.equal((await ledger.readRaw('P', task.id)).split('---\r\n').at(-1), body.replace('- [ ] ship', '- [x] ship'));
  await ledger.appendMemo('P', task.id, 'new memo');
  const written = await ledger.readRaw('P', task.id);
  assert.equal(written.replace(/\r\n/g, '').includes('\n'), false);
  assert.ok(written.includes('\tkeep trailing  \r\n'));
  assert.equal((await ledger.get('P', task.id)).steps[0]?.done, true);
  assert.match((await ledger.get('P', task.id)).memo, /new memo$/);
}));

test('task renaming preserves inline instructions containing both quote styles', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const ledger = new TaskLedger(ws); const task = await ledger.create('P', { title: 'T' });
  await fs.writeFile(ws.taskFile('P', task.id), `---\ntitle: Original # don't lose "this instruction"\n---\nbody\n`);
  await ledger.update('P', task.id, { title: 'Renamed' });
  assert.ok((await ledger.readRaw('P', task.id)).includes(`title: Renamed # don't lose "this instruction"\n`));
}));
