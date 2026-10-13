import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from './projects.ts';
import { TaskLedger } from './tasks.ts';
import { TaskTemplates } from './task-templates.ts';

test('專案與工作區範本往返，不複製步驟完成，禁止覆寫與越界', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const tasks = new TaskLedger(ws); const source = await tasks.create('P', { title: '來源', steps: ['第一步', '下一步'] });
  await tasks.setStep('P', source.id, 0, true, '第一步');
  const templates = new TaskTemplates(ws);
  assert.deepEqual(await templates.list('P'), []);
  for (const scope of ['project', 'workspace'] as const) {
    const saved = await templates.saveFromTask('P', source.id, 'Test', 'do\nthis', scope);
    assert.deepEqual(saved.steps, ['第一步', '下一步']); assert.equal(saved.instruction, 'do\nthis');
    await assert.rejects(templates.saveFromTask('P', source.id, 'Test', '', scope));
    const created = await tasks.create('P', { title: saved.title, steps: saved.steps });
    assert.ok(created.steps.every(step => !step.done));
    await assert.rejects(templates.get('P', scope, '../evil'));
  }
  assert.equal((await templates.list('P')).length, 2);
  await templates.remove('P', 'project', 'Test'); assert.equal((await templates.list('P')).length, 1);
  await fs.writeFile(path.join(ws.root, 'templates', 'bad.md'), '---\ntitle: 42\n---\n');
  assert.equal((await templates.list('P')).length, 1);
  await fs.symlink(ws.taskFile('P', source.id), path.join(ws.root, 'templates', 'linked.md'));
  await assert.rejects(templates.get('P', 'workspace', 'linked'));
}));

test('a template or template folder removed outside the app is reported as not found', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const templates = new TaskTemplates(ws);
  await assert.rejects(templates.get('P', 'project', 'gone'), { status: 404 });
  await assert.rejects(templates.remove('P', 'project', 'gone'), { status: 404 });
  const source = await new TaskLedger(ws).create('P', { title: 'T' });
  await templates.saveFromTask('P', source.id, 'Kept', '', 'project');
  await fs.rm(path.join(ws.projectDir('P'), '.ai', 'templates', 'Kept.md'));
  await assert.rejects(templates.get('P', 'project', 'Kept'), { status: 404 });
  await assert.rejects(templates.remove('P', 'project', 'Kept'), { status: 404 });
}));

test('templates with more steps than a task may have are neither saved nor listed', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const tasks = new TaskLedger(ws); const templates = new TaskTemplates(ws);
  const source = await tasks.create('P', { title: 'T', steps: Array.from({ length: 500 }, (_, i) => `s${i}`) });
  // Hand-edited past the 500-step limit TaskLedger.create enforces.
  const file = ws.taskFile('P', source.id);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('- [ ] s0\n', '- [ ] s0\n- [ ] extra\n'));
  assert.equal((await tasks.get('P', source.id)).steps.length, 501);
  await assert.rejects(templates.saveFromTask('P', source.id, 'Big', '', 'project'), { detail: 'field_type' });
  await fs.mkdir(path.join(ws.projectDir('P'), '.ai', 'templates'), { recursive: true });
  await fs.writeFile(path.join(ws.projectDir('P'), '.ai', 'templates', 'Hand.md'), `---\ntitle: Hand\n---\n## 步驟\n${Array.from({ length: 501 }, (_, i) => `- [ ] s${i}`).join('\n')}\n`);
  assert.deepEqual(await templates.list('P'), []);
}));

test('malformed hand-edited templates do not hide valid ones, and a save the manager could not list is refused', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const tasks = new TaskLedger(ws); const templates = new TaskTemplates(ws);
  const source = await tasks.create('P', { title: 'Source' });
  const dir = path.join(ws.projectDir('P'), '.ai', 'templates'); await fs.mkdir(dir, { recursive: true });
  for (let index = 0; index < 200; index++) await fs.writeFile(path.join(dir, `a${String(index).padStart(3, '0')}.md`), 'not a template');
  await templates.saveFromTask('P', source.id, 'zz-valid', '', 'project');
  assert.deepEqual((await templates.list('P')).map(template => template.name), ['zz-valid']);
  for (let index = 0; index < 200; index++) await fs.writeFile(path.join(dir, `a${String(index).padStart(3, '0')}.md`), `---\ntitle: T${index}\n---\n`);
  assert.equal((await templates.list('P')).length, 200);
  await assert.rejects(templates.saveFromTask('P', source.id, 'zz-more', '', 'project'), { detail: 'templates_full' });
}));
