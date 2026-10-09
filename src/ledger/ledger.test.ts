import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AppError } from '../shared/errors.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from './projects.ts';
import { countSteps, TaskLedger } from './tasks.ts';

test('工作區初始化建立目錄與 roles.yaml', () =>
  withTmpWorkspace(async (ws) => {
    assert.ok((await fs.stat(ws.projectsDir)).isDirectory());
    assert.ok((await fs.stat(ws.workDir)).isDirectory());
    assert.match(await fs.readFile(ws.rolesFile, 'utf8'), /^models:/m);
  }));

test('專案建立、讀取、同名衝突、名稱白名單', () =>
  withTmpWorkspace(async (ws) => {
    const projects = new ProjectLedger(ws);
    assert.deepEqual(await projects.list(), []);
    const p = await projects.create('範例專案');
    assert.equal(p.name, '範例專案');
    assert.equal(p.status, '未開始');
    assert.match(p.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(await fs.readFile(path.join(ws.projectDir('範例專案'), '.gitignore'), 'utf8'), /^\.ai\/$/m);
    await assert.rejects(projects.create('範例專案'), (e: unknown) => e instanceof AppError && e.code === 'conflict');
    await assert.rejects(projects.create('../escape'), (e: unknown) => e instanceof AppError && e.code === 'bad_request');
    await assert.rejects(projects.get('nope'), (e: unknown) => e instanceof AppError && e.code === 'not_found');
    assert.equal((await projects.list()).length, 1);
  }));

test('手改的 PROJECT.md issues／related 能讀回', () =>
  withTmpWorkspace(async (ws) => {
    const projects = new ProjectLedger(ws);
    await projects.create('P');
    await fs.writeFile(
      ws.projectFile('P'),
      '---\nname: P\nstatus: 進行中\nupdated: 2026-10-10\nrelated: [Q]\nissues:\n  - { text: 卡住, level: 高 }\n---\n備註\n',
    );
    const p = await projects.get('P');
    assert.equal(p.status, '進行中');
    assert.deepEqual(p.related, ['Q']);
    assert.deepEqual(p.issues, [{ text: '卡住', level: '高' }]);
  }));

test('作業建立、序號、更新只改指定鍵並保留正文', () =>
  withTmpWorkspace(async (ws) => {
    await new ProjectLedger(ws).create('P');
    const tasks = new TaskLedger(ws);
    const a = await tasks.create('P', '第一件', '實作');
    const b = await tasks.create('P', '第二件');
    assert.match(a.id, /^\d{8}-001$/);
    assert.match(b.id, /^\d{8}-002$/);
    assert.equal(a.role, '實作');
    assert.equal(a.state, '未開始');
    assert.deepEqual(a.steps, { done: 0, total: 1 });

    // 模擬 AI 手改正文
    const file = ws.taskFile('P', a.id);
    const raw = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, raw.replace('- [ ]', '- [x] 讀規格\n- [ ] 寫碼'));

    const updated = await tasks.update('P', a.id, { state: '進行中', question: '要不要加測試？' });
    assert.equal(updated.state, '進行中');
    assert.equal(updated.question, '要不要加測試？');
    assert.deepEqual(updated.steps, { done: 1, total: 2 });
    assert.match(await fs.readFile(file, 'utf8'), /- \[x\] 讀規格\n- \[ \] 寫碼/);

    await assert.rejects(tasks.update('P', a.id, { state: '飛天' as never }), (e: unknown) => e instanceof AppError && e.code === 'bad_request');
    await assert.rejects(tasks.update('P', a.id, {}), (e: unknown) => e instanceof AppError && e.code === 'bad_request');
    await assert.rejects(tasks.get('P', '99999999-999'), (e: unknown) => e instanceof AppError && e.code === 'not_found');
    const list = await tasks.list('P');
    assert.deepEqual(
      list.map((t) => t.id),
      [b.id, a.id],
    );
  }));

test('countSteps 只數「## 步驟」段落', () => {
  assert.deepEqual(countSteps('## 步驟\n- [x] a\n- [ ] b\n## 下一步\n- [ ] c\n'), { done: 1, total: 2 });
  assert.deepEqual(countSteps('沒有步驟'), { done: 0, total: 0 });
});
