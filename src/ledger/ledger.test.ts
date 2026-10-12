import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../shared/config.ts';
import type { AppError } from '../shared/errors.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from './projects.ts';
import { parseSteps, TaskLedger } from './tasks.ts';
import { CompletionStore, phaseKey, stepsHash } from './completion.ts';
import { SettingsStore } from './settings.ts';
import { OrderStore } from './order.ts';
import { OpLog } from './oplog.ts';

test('專案預設、階段推進、改名不搬目錄、階層與外部本體驗證', () => withTmpWorkspace(async (ws, dir) => {
  const projects = new ProjectLedger(ws);
  assert.ok((await fs.stat(ws.internalDir)).isDirectory());
  const p = await projects.create({ name: 'P', description: '說明' });
  assert.equal(p.id, 'P'); assert.equal(p.status, '進行中'); assert.equal(projects.currentPhase(p), '計畫');
  assert.equal(projects.bodyPath(p), ws.projectDir('P'));
  const renamed = await projects.update('P', { name: '新名字' });
  assert.equal(renamed.id, 'P'); assert.equal(renamed.name, '新名字');
  assert.equal((await projects.update('P', { description: '說'.repeat(2000) })).description.length, 2000);
  await assert.rejects(projects.update('P', { description: '說'.repeat(2001) }), (error: AppError) => error.detail === 'field_too_long' && error.field === 'description');
  const relatedError = (error: AppError) => error.detail === 'field_type' && error.field === 'related';
  for (const related of [['../escape'], ['P'], ['Q', 'Q'], Array.from({ length: 51 }, (_, i) => `R${i}`)]) await assert.rejects(projects.update('P', { related }), relatedError);
  assert.equal((await projects.update('P', { related: Array.from({ length: 50 }, (_, i) => `R${i}`) })).related.length, 50);
  await projects.create({ name: 'Child', parent: 'P', body: dir, phases: ['一'] });
  await assert.rejects(projects.update('P', { parent: 'Child' }));
  await assert.rejects(projects.create({ name: 'Invalid', body: path.join(dir, 'absent') }));
  await assert.rejects(projects.create({ name: '../escape' }));
  await assert.rejects(projects.create({ name: 'P' }));
  await assert.rejects(projects.create({ name: 'TooMany', phases: Array.from({ length: 13 }, (_, i) => String(i)) }));
  for (let i = 0; i < 4; i++) await projects.nextPhase('P', projects.currentPhase(await projects.get('P')));
  assert.equal((await projects.get('P')).status, '完成');
  assert.equal(projects.currentPhase(await projects.get('P')), '');
}));

test('舊專案缺欄位仍能讀、issues 與正文保留', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P' });
  await fs.writeFile(ws.projectFile('P'), '---\nname: 舊檔\nstatus: 暫停\nrelated: [Q]\nissues:\n  - { text: 卡住, level: 高 }\n---\n# 備註\n保留內容\n');
  const p = await projects.get('P');
  assert.deepEqual(p.phases, []); assert.equal(p.body, ''); assert.equal(p.description, '');
  assert.deepEqual(p.issues, [{ text: '卡住', level: '高' }]); assert.equal(p.notes, '保留內容');
  await projects.update('P', { description: '新說明' });
  assert.equal((await projects.get('P')).notes, '保留內容');
}));

test('步驟編輯與 memo 只變更自己的段落；舊 owner 與段落相容', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const tasks = new TaskLedger(ws);
  const task = await tasks.create('P', { title: '作業', steps: ['讀規格', '實作'], workspace: 'direct' });
  assert.equal(task.workspace, 'direct'); assert.deepEqual(task.steps, [{ text: '讀規格', done: false }, { text: '實作', done: false }]);
  await tasks.setStep('P', task.id, 0, true, '讀規格');
  await tasks.addStep('P', task.id, '驗證'); await tasks.removeStep('P', task.id, 1, '實作');
  assert.deepEqual((await tasks.get('P', task.id)).steps, [{ text: '讀規格', done: true }, { text: '驗證', done: false }]);
  await assert.rejects(tasks.setStep('P', task.id, 99, true, '讀規格'), (error: AppError) => error.detail === 'step_changed');
  // A page that still shows the removed step at index 1 must not toggle or delete the step that moved into its place.
  await assert.rejects(tasks.setStep('P', task.id, 1, true, '實作'), (error: AppError) => error.detail === 'step_changed');
  await assert.rejects(tasks.removeStep('P', task.id, 1, '實作'), (error: AppError) => error.detail === 'step_changed');
  assert.deepEqual((await tasks.get('P', task.id)).steps, [{ text: '讀規格', done: true }, { text: '驗證', done: false }]);
  await assert.rejects(tasks.appendMemo('P', task.id, 'x'.repeat(301)));
  await tasks.appendMemo('P', task.id, '完成初稿');
  assert.match((await tasks.get('P', task.id)).memo, /完成初稿$/);
  const file = ws.taskFile('P', task.id);
  await fs.writeFile(file, '---\nid: ignored\ntitle: 舊檔\nowner: codex\nstate: 進行中 # 保留\n---\n## 手順\n* [X] 舊步驟\n## 已完成的工作\n不能遺失\n## Next\n先驗證\n## 注意事項\n舊注意\n## メモ\n舊備註\n');
  const old = await tasks.get('P', task.id); assert.equal(old.cli, 'codex'); assert.equal(old.next, '先驗證');
  await tasks.update('P', task.id, { state: '等待回覆', workdir: '/tmp/copy', mergeExcluded: true });
  await tasks.appendMemo('P', task.id, '新備註');
  const raw = await tasks.readRaw('P', task.id);
  assert.match(raw, /state: 等待回覆 # 保留/); assert.match(raw, /## 已完成的工作\n不能遺失/); assert.match(raw, /## 注意事項\n舊注意/);
  assert.deepEqual(parseSteps(raw), [{ text: '舊步驟', done: true }]);
}));

test('多個作業台帳同時改標題、memo 與步驟，且錯誤不阻擋後續更新', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const one = new TaskLedger(ws), two = new TaskLedger(ws);
  const task = await one.create('P', { title: '原標題' });
  await Promise.all([one.update('P', task.id, { title: 'renamed' }), two.appendMemo('P', task.id, 'memo-1'), one.addStep('P', task.id, 'step-1')]);
  const result = await two.get('P', task.id);
  assert.equal(result.title, 'renamed'); assert.match(result.memo, /memo-1/);
  assert.deepEqual(result.steps, [{ text: 'step-1', done: false }]);
  const edits = await Promise.allSettled([one.update('P', task.id, { title: '' }), two.setStep('P', task.id, 0, true, 'step-1')]);
  assert.equal(edits[0]!.status, 'rejected'); assert.equal(edits[1]!.status, 'fulfilled');
  assert.deepEqual((await one.get('P', task.id)).steps, [{ text: 'step-1', done: true }]);
}));

test('多個專案台帳同時更新欄位與推進階段，不覆蓋先前變更，同一階段只推進一次', () => withTmpWorkspace(async ws => {
  const one = new ProjectLedger(ws), two = new ProjectLedger(ws);
  await one.create({ name: 'P' });
  const results = await Promise.allSettled([one.update('P', { name: '新名字' }), two.update('P', { description: '新說明' }), one.nextPhase('P', '計畫'), two.nextPhase('P', '計畫')]);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.detail, 'phase_changed');
  const project = await two.get('P');
  assert.equal(project.name, '新名字'); assert.equal(project.description, '新說明');
  assert.deepEqual(project.phases.map(phase => phase.state), ['完成', '進行中', '未開始', '未開始']);
}));

test('封存與更新排隊，不遺失更新或重建已封存的目錄', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '原標題' });
  await Promise.all([tasks.update('P', task.id, { title: '封存前' }), tasks.archive('P', task.id)]);
  const trash = path.join(ws.projectDir('P'), '.ai', 'trash');
  const [entry] = await fs.readdir(trash);
  assert.match(await fs.readFile(path.join(trash, entry!, `${task.id}.md`), 'utf8'), /title: 封存前/);
  await assert.rejects(tasks.get('P', task.id));
  await Promise.all([projects.update('P', { description: '封存前說明' }), projects.archive('P')]);
  await assert.rejects(fs.access(ws.projectDir('P')));
  await assert.rejects(tasks.create('P', { title: '不存在' }));
  await assert.rejects(fs.access(ws.projectDir('P')));
}));

test('作業序號掃描 chat 與 Work，封存與並行建立也不重用', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const tasks = new TaskLedger(ws);
  const a = await tasks.create('P', { title: '第一件' });
  await tasks.archive('P', a.id);
  const b = await tasks.create('P', { title: '第二件' }); assert.notEqual(a.id, b.id);
  const day = a.id.slice(0, 8);
  await fs.writeFile(ws.chatFile('P', `${day}-050`, 'jsonl'), '');
  await fs.mkdir(ws.worktreeDir('P', `${day}-080`), { recursive: true });
  const rows = await Promise.all(Array.from({ length: 4 }, (_, i) => tasks.create('P', { title: `並行 ${i}` })));
  assert.deepEqual(rows.map(t => t.id), [81,82,83,84].map(n => `${day}-${String(n).padStart(3, '0')}`));
}));

test('完成核可、continue hash、階段 key 與多實例寫入不互相覆蓋', () => withTmpWorkspace(async ws => {
  const one = new CompletionStore(ws), two = new CompletionStore(ws);
  await Promise.all([one.approve('P', 'a'), two.approve('P', 'b')]);
  assert.equal(await one.isApproved('P', 'a'), true); assert.equal(await two.isApproved('P', 'b'), true);
  await one.revoke('P', 'a'); assert.equal(await one.isApproved('P', 'a'), false);
  const hash = stepsHash([{ text: '做事', done: true }]); await one.setContinued('P', 'a', hash);
  assert.equal(await two.continued('P', 'a'), hash); assert.notEqual(hash, stepsHash([{ text: '新事', done: true }]));
  await new ProjectLedger(ws).create({ name: 'P' }); const tasks = new TaskLedger(ws);
  const a = await tasks.create('P', { title: 'A' }), b = await tasks.create('P', { title: 'B' });
  assert.equal(phaseKey([a,b]), phaseKey([b,a]));
  await one.setPhaseContinued('P', phaseKey([a,b])); assert.equal(await two.phaseContinued('P'), phaseKey([a,b]));
}));

test('設定預設取 config、驗證陣列與 AI；排序與釘選；紀錄 newest-first 上限', () => withTmpWorkspace(async ws => {
  const settings = new SettingsStore(ws, parseConfig('cli:\n  claude:\n    fullAccess: false\n', null));
  assert.deepEqual((await settings.get()).initial, { ai: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal((await settings.get()).fullAccess['claude'], false);
  await settings.update({ hiddenModels: { codex: ['one'] }, fullAccess: { codex: false } });
  await settings.update({ hiddenModels: { claude: ['two'] } });
  assert.deepEqual((await settings.get()).hiddenModels, { codex: ['one'], claude: ['two'] });
  await assert.rejects(settings.update({ initial: { ai: 'mock', model: '', effort: '' } }));
  await assert.rejects(settings.update({ modelOrder: { codex: [1] as never } }));
  const order = new OrderStore(ws); assert.deepEqual(await order.setOrder('', ['B','A','B']), ['B','A']);
  await order.setPinned('B', true); await order.setPinned('A', true); assert.deepEqual(await order.setPinned('B', false), ['A']);
  const oplog = new OpLog(ws);
  for (let i = 0; i < 205; i++) await oplog.record({ action: 'test', i });
  const recent = await oplog.recent(999); assert.equal(recent.length, 200); assert.equal(recent[0]!['i'], 204);
  assert.deepEqual(await oplog.recent(0), []);
  await fs.rm(path.join(ws.internalDir, 'log.jsonl')); await fs.mkdir(path.join(ws.internalDir, 'log.jsonl'));
  await assert.doesNotReject(oplog.record({ action: 'still-safe' }));
}));

test('hand-written comma-separated tags are read as tags and survive tag edits', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P', description: '' });
  const tasks = new TaskLedger(ws);
  const task = await tasks.create('P', { title: 'T' });
  const file = ws.taskFile('P', task.id);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/^tags:.*$/m, 'tags: important, urgent'));
  assert.deepEqual((await tasks.get('P', task.id)).tags, ['important', 'urgent']);
  assert.deepEqual((await tasks.update('P', task.id, {}, { tag: 'later', add: true })).tags, ['important', 'urgent', 'later']);
  assert.deepEqual((await tasks.update('P', task.id, {}, { tag: 'urgent', add: false })).tags, ['important', 'later']);
}));
