import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { WorktreeService } from './worktree.ts';
import { WorkflowIntegrationService } from './workflow-integration.ts';
import { commitAll, gitOk } from './git.ts';

for (const conflicting of [false, true]) test(`candidate snapshots working changes without publishing main (conflicting=${conflicting})`, () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); await projects.create({ name: 'P' });
  const tasks = new TaskLedger(ws); const parent = await tasks.create('P', { title: 'workflow' });
  const worktrees = new WorktreeService({ ws, projects, tasks, diffBytes: 100000 });
  await worktrees.prepare('P', parent.id); const repo = await worktrees.bodyPath('P');
  await fs.writeFile(path.join(repo, 'shared.txt'), 'base\n'); await commitAll(repo, 'base');
  const main = await gitOk(repo, ['rev-parse', 'HEAD']);
  const sources: string[] = []; const indexes: string[] = [];
  for (const name of ['a', 'b']) {
    const task = await tasks.create('P', { title: name, workspace: 'isolated' }); const dir = await worktrees.prepare('P', task.id);
    await fs.writeFile(path.join(dir, conflicting ? 'shared.txt' : `${name}.txt`), `${name}\n`);
    await fs.writeFile(path.join(dir, '.env.workflow-secret'), 'must-not-snapshot');
    sources.push(task.id); indexes.push(await gitOk(dir, ['diff', '--cached']));
  }
  const service = new WorkflowIntegrationService({ tasks, worktrees, busy: () => false });
  const candidate = await service.create('P', parent.id, parent.role, sources);
  assert.equal(await gitOk(repo, ['rev-parse', 'HEAD']), main);
  assert.equal(await fs.readFile(path.join(repo, 'shared.txt'), 'utf8'), 'base\n');
  assert.equal(candidate.state, conflicting ? 'conflict' : 'ready');
  const target = await tasks.get('P', candidate.task);
  if (conflicting) {
    assert.deepEqual(candidate.conflicts, ['shared.txt']);
    assert.equal((await service.resolve('P', candidate)).state, 'conflict');
  } else {
    for (const name of ['a', 'b']) assert.equal(await fs.readFile(path.join(target.workdir, `${name}.txt`), 'utf8'), `${name}\n`);
    await service.assertReady('P', candidate);
    await assert.rejects(fs.access(path.join(target.workdir, '.env.workflow-secret')));
    await fs.writeFile(path.join(target.workdir, 'a.txt'), 'changed after preview');
    await assert.rejects(service.assertReady('P', candidate), { code: 'conflict' });
  }
  for (const [index, source] of sources.entries()) assert.equal(await gitOk((await tasks.get('P', source)).workdir, ['diff', '--cached']), indexes[index]);
  await fs.writeFile(path.join(repo, 'dirty.txt'), 'not selected');
  await assert.rejects(service.create('P', parent.id, parent.role, sources), { code: 'conflict' });
}));
