import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { git, gitOk, commitAll } from './git.ts';
import { GitWorkbench } from './workbench.ts';
import { WorktreeService } from './worktree.ts';
import { AppError } from '../shared/errors.ts';

test('人工暫存、取消、提交、fetch與非強制push僅使用tmp bare remote', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' }); const root = ws.projectDir('P');
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  const remote = path.join(ws.root, 'remote.git'); await fs.mkdir(remote);
  await gitOk(remote, ['init', '--bare', '-q']); await gitOk(root, ['remote', 'add', 'origin', remote]);
  await fs.writeFile(path.join(root, 'new.txt'), 'new\n');
  assert.equal((await workbench.status('P')).files.find(file => file.path === 'new.txt')?.untracked, true);
  await workbench.stage('P', undefined, 'new.txt');
  assert.equal((await workbench.status('P')).files.find(file => file.path === 'new.txt')?.staged, true);
  await fs.appendFile(path.join(root, 'new.txt'), 'later\n');
  const mixed = (await workbench.status('P')).files.find(file => file.path === 'new.txt');
  assert.equal(mixed?.staged, true); assert.equal(mixed?.unstaged, true);
  await workbench.stage('P', undefined, 'new.txt', true);
  assert.equal((await workbench.status('P')).files.find(file => file.path === 'new.txt')?.untracked, true);
  await workbench.stage('P', undefined, 'new.txt');
  await assert.rejects(workbench.commit('P', undefined, ''), (error: unknown) => error instanceof AppError && error.detail === 'git_commit_message');
  const result = await workbench.commit('P', undefined, 'human commit');
  assert.match(result.sha, /^[0-9a-f]{40}$/);
  await assert.rejects(workbench.push('P', undefined, 'origin', false));
  await workbench.push('P', undefined, 'origin', true);
  const branch = (await workbench.status('P')).branch;
  assert.equal((await gitOk(remote, ['rev-parse', `refs/heads/${branch}`])).trim(), result.sha);
  await workbench.fetch('P', undefined, 'origin');
  const status = await workbench.status('P'); assert.equal(status.upstream, `origin/${branch}`); assert.equal(status.ahead, 0); assert.equal(status.behind, 0);
  await workbench.branch('P', undefined, 'human/topic', true); assert.equal((await workbench.status('P')).branch, 'human/topic');
  await workbench.branch('P', undefined, branch, false);
  await fs.writeFile(path.join(root, '.env.private'), 'private');
  await assert.rejects(workbench.stage('P', undefined, '.env.private'));
  await gitOk(root, ['add', '-f', '--', '.env.private']);
  await assert.rejects(workbench.commit('P', undefined, 'must not publish'), (error: unknown) => error instanceof AppError && error.detail === 'git_workbench_secret');
  await workbench.stage('P', undefined, '.env.private', true);
  await assert.rejects(workbench.stage('P', undefined, '../outside'));
  await fs.symlink(path.join(ws.root, 'remote.git'), path.join(root, 'escape'));
  await assert.rejects(workbench.stage('P', undefined, 'escape'));
}));

test('真實 merge conflict 可人工編輯、resolve、提交且不改其他worktree', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' }); const root = ws.projectDir('P');
  await fs.writeFile(path.join(root, 'conflict.txt'), 'base\n'); await commitAll(root, 'base');
  const task = await tasks.create('P', { title: 'conflict' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 }); const dir = await wt.prepare('P', task.id);
  await fs.writeFile(path.join(dir, 'conflict.txt'), 'task\n'); await commitAll(dir, 'task');
  await fs.writeFile(path.join(root, 'conflict.txt'), 'main\n'); await commitAll(root, 'main');
  assert.equal((await git(dir, ['merge', 'main'])).code, 1);
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  assert.equal((await workbench.status('P', task.id)).files.find(file => file.path === 'conflict.txt')?.conflict, true);
  assert.deepEqual(await workbench.conflict('P', task.id, 'conflict.txt'), { path: 'conflict.txt', base: 'base\n', ours: 'task\n', theirs: 'main\n' });
  await assert.rejects(workbench.resolve('P', task.id, 'conflict.txt'), (error: unknown) => error instanceof AppError && error.detail === 'git_conflict_markers');
  await fs.writeFile(path.join(dir, 'conflict.txt'), 'resolved\n');
  await workbench.resolve('P', task.id, 'conflict.txt');
  assert.equal((await workbench.status('P', task.id)).files.some(file => file.conflict), false);
  await workbench.commit('P', task.id, 'resolve conflict');
  assert.equal((await gitOk(dir, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length, 3);
  assert.equal(await fs.readFile(path.join(root, 'conflict.txt'), 'utf8'), 'main\n');
}));

test('PR缺gh與缺auth明確拒絕且不進行網路發布', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const missing = new GitWorkbench({ ws, projects, tasks, isRunning: () => false, ghCommand: path.join(ws.root, 'missing-gh') });
  assert.deepEqual(await missing.pullRequestStatus('P'), { available: false, authenticated: false, repository: null });
  const input = { title: 'title', body: 'body', base: 'main', head: 'topic', confirmed: true };
  await assert.rejects(missing.pullRequest('P', undefined, input), (error: unknown) => error instanceof AppError && error.detail === 'gh_unavailable');
  if (process.platform !== 'win32') {
    const command = path.join(ws.root, 'unauthenticated-gh');
    await fs.writeFile(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const unauthenticated = new GitWorkbench({ ws, projects, tasks, isRunning: () => false, ghCommand: command });
    assert.deepEqual(await unauthenticated.pullRequestStatus('P'), { available: true, authenticated: false, repository: null });
    await assert.rejects(unauthenticated.pullRequest('P', undefined, input), (error: unknown) => error instanceof AppError && error.detail === 'gh_auth_required');
  }
}));

test('行暫存／取消以精確index與worktree指紋拒絕過期選取，保留未選取變更', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const full = path.join(root, 'lines.txt');
  await fs.writeFile(full, 'one\ntwo\nthree\n'); await commitAll(root, 'base');
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(full, 'ONE\ntwo\nTHREE\n');
  const diff = await workbench.diff('P', undefined, 'lines.txt', false);
  const selected = diff.hunks.flatMap(h => h.lines).filter(line => line.text === 'one' || line.text === 'ONE').map(line => line.id);
  await workbench.stageLines('P', undefined, 'lines.txt', false, diff.fingerprint, selected);
  assert.equal(await gitOk(root, ['show', ':lines.txt']), 'ONE\ntwo\nthree\n');
  assert.equal(await fs.readFile(full, 'utf8'), 'ONE\ntwo\nTHREE\n');
  await assert.rejects(workbench.stageLines('P', undefined, 'lines.txt', false, diff.fingerprint, selected));
  const staged = await workbench.diff('P', undefined, 'lines.txt', true);
  await workbench.stageLines('P', undefined, 'lines.txt', true, staged.fingerprint, staged.hunks.flatMap(h => h.lines).filter(line => line.kind !== 'context').map(line => line.id));
  assert.equal(await gitOk(root, ['show', ':lines.txt']), 'one\ntwo\nthree\n');
  const fresh = await workbench.diff('P', undefined, 'lines.txt', false);
  await fs.appendFile(full, 'external\n');
  await assert.rejects(workbench.stageLines('P', undefined, 'lines.txt', false, fresh.fingerprint, fresh.hunks.flatMap(h => h.lines).filter(line => line.kind !== 'context').map(line => line.id)));
}));

test('新檔、刪檔與沒有最後換行的部分暫存保留未選取資料', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(path.join(root, 'new.txt'), 'first\nsecond\n');
  const fresh = await workbench.diff('P', undefined, 'new.txt', false);
  await workbench.stageLines('P', undefined, 'new.txt', false, fresh.fingerprint, [fresh.hunks[0]!.lines[0]!.id]);
  assert.equal(await gitOk(root, ['show', ':new.txt']), 'first\n');
  await workbench.stage('P', undefined, 'new.txt'); await workbench.commit('P', undefined, 'base');
  await fs.unlink(path.join(root, 'new.txt'));
  const deleted = await workbench.diff('P', undefined, 'new.txt', false);
  await workbench.stageLines('P', undefined, 'new.txt', false, deleted.fingerprint, [deleted.hunks[0]!.lines[0]!.id]);
  assert.equal(await gitOk(root, ['show', ':new.txt']), 'second\n');
  await fs.writeFile(path.join(root, 'new.txt'), 'second');
  const newline = await workbench.diff('P', undefined, 'new.txt', false);
  await workbench.stageLines('P', undefined, 'new.txt', false, newline.fingerprint, newline.hunks.flatMap(h => h.lines).filter(line => line.kind !== 'context').map(line => line.id));
  assert.equal(await gitOk(root, ['show', ':new.txt']), 'second');
}));

test('人工commit預設執行hook，略過需明確確認', () => withTmpWorkspace(async ws => {
  if (process.platform === 'win32') return;
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  const hooks = path.join(ws.root, 'hooks'); await fs.mkdir(hooks);
  await fs.writeFile(path.join(hooks, 'pre-commit'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  await gitOk(root, ['config', 'core.hooksPath', hooks]);
  await fs.writeFile(path.join(root, 'hook.txt'), 'text\n'); await workbench.stage('P', undefined, 'hook.txt');
  await assert.rejects(workbench.commit('P', undefined, 'blocked'));
  await assert.rejects(workbench.commit('P', undefined, 'unconfirmed', { bypassHooks: true }));
  const result = await workbench.commit('P', undefined, 'confirmed', { bypassHooks: true, confirmed: true });
  assert.equal((await gitOk(root, ['rev-parse', 'HEAD'])).trim(), result.sha);
}));

test('比較真實作業副本未提交變更且不外洩secret／不接受symlink', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const left = await tasks.create('P', { title: 'left' }); const right = await tasks.create('P', { title: 'right' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const a = await wt.prepare('P', left.id); const b = await wt.prepare('P', right.id);
  await fs.writeFile(path.join(a, 'solution.txt'), 'left\n'); await fs.writeFile(path.join(b, 'solution.txt'), 'right\n');
  await fs.writeFile(path.join(a, '.env.private'), 'secret-token');
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  const comparison = await workbench.compareTasks('P', left.id, right.id);
  assert.deepEqual(comparison.files.map(file => file.path), ['solution.txt']);
  assert.match(comparison.files[0]!.patch, /-left/); assert.match(comparison.files[0]!.patch, /\+right/);
  assert.equal(JSON.stringify(comparison).includes('secret-token'), false);
  await fs.symlink(path.join(ws.root, 'outside'), path.join(a, 'escape.txt'));
  await assert.rejects(workbench.compareTasks('P', left.id, right.id));
}));

test('歷史、提交詳情與blame限制輸入並保護機密路徑', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(path.join(root, 'history.txt'), 'first\n'); await commitAll(root, 'first history');
  await fs.appendFile(path.join(root, 'history.txt'), 'second\n'); await commitAll(root, 'second history');
  const sha = (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
  assert.match((await workbench.history('P', undefined, 0, 'history.txt')).graph, /second history/);
  assert.equal((await workbench.history('P', undefined, 100)).graph, '');
  const detail = await workbench.commitDetail('P', undefined, sha);
  assert.match(detail.metadata, /second history/); assert.deepEqual(detail.files, ['history.txt']); assert.match(detail.patch, /\+second/);
  assert.match(await workbench.blame('P', undefined, 'history.txt'), /author YuMeewADE/);
  await assert.rejects(workbench.history('P', undefined, -1));
  await assert.rejects(workbench.commitDetail('P', undefined, '--all'));
  await assert.rejects(workbench.blame('P', undefined, '.env'));
  await assert.rejects(workbench.history('P', undefined, 0, '../escape'));
}));
