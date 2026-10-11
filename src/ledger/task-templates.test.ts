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
  await tasks.setStep('P', source.id, 0, true);
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
