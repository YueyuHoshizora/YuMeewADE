import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from './projects.ts';
import { TaskLedger } from './tasks.ts';
import { TaskLinkedFeedback } from './task-linked-feedback.ts';
import type { LinkedFeedback } from '../shared/github.ts';

const source: Omit<LinkedFeedback, 'revision'> = { repository: 'o/r', kind: 'thread', number: 12, url: 'https://github.com/o/r/pull/12#discussion_r1', threadId: 'PRRT_1', commentId: 'PRRC_1', path: 'a.ts', line: 1, source: 'Fix', headOid: 'a'.repeat(40), draft: 'Saved instruction', resolved: false, state: '' };

test('feedback provenance is atomic, revision checked and separate from task Markdown', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const tasks = new TaskLedger(ws), ledger = new TaskLinkedFeedback(ws, tasks);
  const task = await tasks.create('P', { title: 'Feedback' }), markdown = await tasks.readRaw('P', task.id);
  assert.equal(await ledger.get('P', task.id), null);
  const saved = await ledger.create('P', task.id, source);
  assert.deepEqual(await ledger.get('P', task.id), saved);
  await assert.rejects(ledger.create('P', task.id, source));
  let invoked = false;
  await assert.rejects(ledger.change('P', task.id, 'stale', async value => { invoked = true; return value; }));
  assert.equal(invoked, false);
  const changed = await ledger.change('P', task.id, saved.revision, async value => ({ ...value, draft: '' }));
  assert.notEqual(changed.revision, saved.revision); assert.equal(changed.draft, '');
  assert.equal(await tasks.readRaw('P', task.id), markdown);
  await assert.rejects(ledger.change('P', task.id, changed.revision, async value => ({ ...value, draft: 'x'.repeat(100001) })));
  assert.deepEqual(await ledger.get('P', task.id), changed);
  await assert.rejects(ledger.get('P', '../escape'));
  const dir = path.join(ws.projectDir('P'), '.ai', 'task-linked-feedback');
  const file = path.join(dir, `${task.id}.json`);
  await fs.unlink(file); await fs.symlink(ws.taskFile('P', task.id), file);
  await assert.rejects(ledger.get('P', task.id));
}));

test('feedback ledger rejects symlink directories and malformed or oversized data', () => withTmpWorkspace(async ws => {
  await new ProjectLedger(ws).create({ name: 'P' });
  const tasks = new TaskLedger(ws), ledger = new TaskLinkedFeedback(ws, tasks), task = await tasks.create('P', { title: 'Feedback' });
  const dir = path.join(ws.projectDir('P'), '.ai', 'task-linked-feedback');
  await fs.symlink(ws.internalDir, dir); await assert.rejects(ledger.get('P', task.id)); await fs.unlink(dir);
  await assert.rejects(ledger.create('P', task.id, { ...source, draft: '\u0001'.repeat(100000) }));
  const file = path.join(dir, `${task.id}.json`);
  await fs.writeFile(file, '{}'); await assert.rejects(ledger.get('P', task.id));
  await fs.writeFile(file, 'x'.repeat(512001)); await assert.rejects(ledger.get('P', task.id));
}));
