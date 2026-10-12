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
  assert.match(comparison.files[0]!.patch, /^diff --git a\/solution\.txt b\/solution\.txt$/m);
  assert.match(comparison.files[0]!.patch, /^--- a\/solution\.txt$/m); assert.match(comparison.files[0]!.patch, /^\+\+\+ b\/solution\.txt$/m);
  assert.equal(comparison.files[0]!.patch.includes(ws.root), false);
  assert.equal(JSON.stringify(comparison).includes('secret-token'), false);
  await fs.symlink(path.join(ws.root, 'outside'), path.join(a, 'escape.txt'));
  await assert.rejects(workbench.compareTasks('P', left.id, right.id));
}));

test('task comparison scales with the difference, uses staged content and marks a cut list', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P');
  // More files than the old 5,000-path cap; all identical between the two copies.
  await fs.mkdir(path.join(root, 'many'));
  await Promise.all(Array.from({ length: 6000 }, (_, i) => fs.writeFile(path.join(root, 'many', `f${i}.txt`), `${i}\n`)));
  await fs.writeFile(path.join(root, 'a.txt'), 'base\n'); await fs.writeFile(path.join(root, 'b.txt'), 'base\n');
  await commitAll(root, 'many files');
  const left = await tasks.create('P', { title: 'left' }); const right = await tasks.create('P', { title: 'right' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const a = await wt.prepare('P', left.id); const b = await wt.prepare('P', right.id);
  await fs.writeFile(path.join(a, 'a.txt'), 'left\n');
  // Staged in the right copy only: the worktree equals the index, which differs from the left copy.
  await fs.writeFile(path.join(b, 'b.txt'), 'staged\n'); await gitOk(b, ['add', 'b.txt']);
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  const comparison = await workbench.compareTasks('P', left.id, right.id);
  assert.deepEqual(comparison.files.map(file => file.path), ['a.txt', 'b.txt']);
  assert.match(comparison.files[1]!.patch, /\+staged/); assert.equal(comparison.truncated, undefined);
  await Promise.all(Array.from({ length: 120 }, (_, i) => fs.writeFile(path.join(b, `new${String(i).padStart(3, '0')}.txt`), 'x\n')));
  const cut = await workbench.compareTasks('P', left.id, right.id);
  assert.equal(cut.files.length, 100); assert.equal(cut.truncated, true);
}));

test('the diff of a file too large for line staging says when it is cut', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(path.join(root, 'big.txt'), 'old\n'); await commitAll(root, 'big');
  await fs.writeFile(path.join(root, 'big.txt'), 'line of generated output\n'.repeat(60_000));
  const big = await workbench.diff('P', undefined, 'big.txt', false);
  assert.equal(big.selectable, false); assert.equal(big.truncated, true); assert.ok(big.patch.length <= 1024 * 1024);
  // A large binary file yields a one-line patch: complete, so not flagged.
  await fs.writeFile(path.join(root, 'big.txt'), Buffer.alloc(1024 * 1024 + 1));
  const binary = await workbench.diff('P', undefined, 'big.txt', false);
  assert.match(binary.patch, /Binary files/); assert.equal(binary.truncated, undefined);
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
  const blame = await workbench.blame('P', undefined, 'history.txt');
  assert.deepEqual(blame.map(line => [line.line, line.text, line.author, line.summary, line.committed]), [[1, 'first', 'YuMeewADE', 'first history', true], [2, 'second', 'YuMeewADE', 'second history', true]]);
  assert.equal(blame[1]!.sha, sha);
  await assert.rejects(workbench.history('P', undefined, -1));
  await assert.rejects(workbench.commitDetail('P', undefined, '--all'));
  await assert.rejects(workbench.blame('P', undefined, '.env'));
  await assert.rejects(workbench.history('P', undefined, 0, '../escape'));
}));

test('stash SHA防過期、drop確認、cherry-pick衝突回滾與rebase繼續／取消', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(path.join(root, 'file.txt'), 'base\n'); await commitAll(root, 'base');
  await fs.writeFile(path.join(root, 'new.txt'), 'untracked\n');
  await workbench.stash('P', undefined, 'push', { message: 'save', includeUntracked: true });
  const stash = (await workbench.stashes('P'))[0]!; assert.match(stash.message, /save/);
  await assert.rejects(workbench.stash('P', undefined, 'drop', { sha: stash.sha }));
  await workbench.stash('P', undefined, 'apply', { sha: stash.sha });
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'untracked\n');
  await fs.rm(path.join(root, 'new.txt'));
  await workbench.stash('P', undefined, 'pop', { sha: stash.sha });
  assert.equal((await workbench.stashes('P')).length, 0);
  await assert.rejects(workbench.stash('P', undefined, 'drop', { sha: stash.sha, confirmed: true }));
  await workbench.stash('P', undefined, 'push', { message: 'drop', includeUntracked: true });
  await workbench.stash('P', undefined, 'drop', { sha: (await workbench.stashes('P'))[0]!.sha, confirmed: true });
  await workbench.branch('P', undefined, 'topic', true);
  await fs.writeFile(path.join(root, 'file.txt'), 'topic\n'); await commitAll(root, 'topic');
  const sha = (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
  await workbench.branch('P', undefined, 'main', false);
  await fs.writeFile(path.join(root, 'file.txt'), 'main\n'); await commitAll(root, 'main');
  const main = (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
  await assert.rejects(workbench.rewrite('P', undefined, 'cherry-pick', sha, false));
  await assert.rejects(workbench.rewrite('P', undefined, 'cherry-pick', sha, true));
  assert.equal((await gitOk(root, ['rev-parse', 'HEAD'])).trim(), main);
  assert.equal((await workbench.status('P')).files.length, 0);
  await workbench.branch('P', undefined, 'topic', false);
  await fs.writeFile(path.join(root, 'dirty'), 'dirty');
  await assert.rejects(workbench.rewrite('P', undefined, 'rebase', 'main', true));
  await fs.rm(path.join(root, 'dirty'));
  assert.deepEqual(await workbench.rewrite('P', undefined, 'rebase', 'main', true), { conflicts: true });
  assert.equal((await workbench.conflict('P', undefined, 'file.txt')).base, 'base\n');
  await workbench.rewrite('P', undefined, 'abort', '', true);
  assert.equal((await gitOk(root, ['rev-parse', 'HEAD'])).trim(), sha);
  await workbench.rewrite('P', undefined, 'rebase', 'main', true);
  await fs.writeFile(path.join(root, 'file.txt'), 'resolved\n'); await workbench.resolve('P', undefined, 'file.txt');
  await workbench.rewrite('P', undefined, 'continue', '', true);
  assert.equal((await workbench.status('P')).branch, 'topic');
  assert.equal((await workbench.status('P')).files.length, 0);
  await assert.rejects(workbench.rewrite('P', undefined, 'abort', '', true));
}));

test('stash with untracked files leaves local secrets in the folder and out of Git objects', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  // An existing repository need not ignore its secrets the way a new project's .gitignore does.
  await fs.writeFile(path.join(root, '.gitignore'), '.ai/\n'); await fs.writeFile(path.join(root, 'file.txt'), 'base\n'); await commitAll(root, 'base');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=fake\n'); await fs.writeFile(path.join(root, 'fresh.txt'), 'fresh\n'); await fs.writeFile(path.join(root, 'file.txt'), 'changed\n');
  await workbench.stash('P', undefined, 'push', { message: 'save', includeUntracked: true });
  assert.equal((await gitOk(root, ['ls-tree', '-r', '--name-only', 'stash@{0}^3'])).trim(), 'fresh.txt');
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'TOKEN=fake\n');
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'base\n');
  await assert.rejects(fs.access(path.join(root, 'fresh.txt')));
}));

test('a merge resolved entirely in favour of this side can still be committed; with no merge, nothing staged is refused', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(path.join(root, 'file.txt'), 'base\n'); await commitAll(root, 'base');
  await assert.rejects(workbench.commit('P', undefined, 'empty'), { detail: 'git_nothing_staged' });
  await gitOk(root, ['switch', '-q', '-c', 'topic']); await fs.writeFile(path.join(root, 'file.txt'), 'theirs\n'); await commitAll(root, 'theirs');
  await gitOk(root, ['switch', '-q', 'main']); await fs.writeFile(path.join(root, 'file.txt'), 'ours\n'); await commitAll(root, 'ours');
  await git(root, ['merge', 'topic']);
  await fs.writeFile(path.join(root, 'file.txt'), 'ours\n');
  await workbench.resolve('P', undefined, 'file.txt');
  await workbench.commit('P', undefined, 'merge topic, keep ours');
  assert.equal((await gitOk(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length, 3);
}));

test('discarding unstaged edits of a staged rename keeps the rename', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(path.join(root, 'old.txt'), 'base\n'); await commitAll(root, 'base');
  await gitOk(root, ['mv', 'old.txt', 'new.txt']); await fs.appendFile(path.join(root, 'new.txt'), 'unstaged\n');
  const fingerprint = (await workbench.diff('P', undefined, 'new.txt', false)).fingerprint!;
  await workbench.discard('P', undefined, 'new.txt', fingerprint);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'base\n');
  assert.equal((await gitOk(root, ['status', '--porcelain'])).trim(), 'R  old.txt -> new.txt');
}));

test('Unicode branch names Git accepts can be created, switched, renamed and deleted; option-like and invalid names cannot', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(path.join(root, 'file.txt'), 'base\n'); await commitAll(root, 'base');
  await workbench.branch('P', undefined, '功能/修正', true);
  await workbench.branch('P', undefined, 'main', false);
  await workbench.branch('P', undefined, '功能/修正', false);
  assert.equal((await gitOk(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), '功能/修正');
  await workbench.branch('P', undefined, 'main', false);
  await workbench.manageBranch('P', undefined, 'rename', '功能/修正', { newName: '機能/修正' });
  await workbench.manageBranch('P', undefined, 'delete', '機能/修正', { confirmed: true });
  assert.equal((await gitOk(root, ['branch', '--list', '機能/修正'])).trim(), '');
  for (const name of ['-x', 'a..b', 'a b', 'a/.b', 'x.lock', 'a@{b']) await assert.rejects(workbench.branch('P', undefined, name, true), { detail: 'git_branch_invalid' });
}));

test('遠端新增、改名、fetch/push URL及移除驗證與確認', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  for (const name of ['', '-x', 'a..b', 'a//b', 'a/.b', 'a.lock/x', 'a.', 'a/', 'x'.repeat(101)]) await assert.rejects(workbench.remote('P', undefined, 'add', name, { url: 'https://example.com/repo' }));
  for (const url of ['', 'http://example.com/repo', 'ext::evil', '/tmp/repo', 'https://example.com/a b', 'ssh://host/\nfoo', 'https://', 'x'.repeat(2049)]) await assert.rejects(workbench.remote('P', undefined, 'add', 'origin', { url }));
  for (const url of ['https://example.com/repo', 'ssh://git@example.com/repo', 'git://example.com/repo', `file://${ws.root}/repo`, 'git@example.com:org/repo']) {
    await workbench.remote('P', undefined, 'add', 'origin', { url });
    assert.deepEqual(await workbench.remotes('P'), [{ name: 'origin', fetchUrls: [url], pushUrls: [url] }]);
    await workbench.remote('P', undefined, 'remove', 'origin', { confirmed: true });
  }
  await workbench.remote('P', undefined, 'add', 'origin', { url: 'https://example.com/fetch' });
  await assert.rejects(workbench.remote('P', undefined, 'rename', 'origin', { newName: 'bad..name' }));
  await workbench.remote('P', undefined, 'rename', 'origin', { newName: 'upstream' });
  await workbench.remote('P', undefined, 'set-url', 'upstream', { url: 'ssh://git@example.com/fetch' });
  await workbench.remote('P', undefined, 'set-url', 'upstream', { url: 'git@example.com:push', push: true });
  assert.deepEqual(await workbench.remotes('P'), [{ name: 'upstream', fetchUrls: ['ssh://git@example.com/fetch'], pushUrls: ['git@example.com:push'] }]);
  await assert.rejects(workbench.remote('P', undefined, 'remove', 'upstream', {}));
  await workbench.remote('P', undefined, 'remove', 'upstream', { confirmed: true });
  assert.deepEqual(await workbench.remotes('P'), []);
}));

test('本地分支改名、合併安全刪除、強制雙確認及現行／live作業保護', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await fs.writeFile(path.join(root, 'branch.txt'), 'base'); await commitAll(root, 'base');
  const current = (await workbench.status('P')).branch;
  await gitOk(root, ['branch', 'merged']);
  await workbench.manageBranch('P', undefined, 'rename', 'merged', { newName: 'renamed' });
  assert.ok((await workbench.status('P')).branches.includes('renamed'));
  await assert.rejects(workbench.manageBranch('P', undefined, 'rename', 'renamed', { newName: 'bad//name' }));
  await assert.rejects(workbench.manageBranch('P', undefined, 'delete', 'renamed', {}));
  await workbench.manageBranch('P', undefined, 'delete', 'renamed', { confirmed: true });
  assert.ok(!(await workbench.status('P')).branches.includes('renamed'));
  await assert.rejects(workbench.manageBranch('P', undefined, 'delete', current, { confirmed: true, force: true, forceConfirmed: true }));
  const task = await tasks.create('P', { title: 'live' }); await gitOk(root, ['branch', `ym/${task.id}`]);
  await assert.rejects(workbench.manageBranch('P', undefined, 'delete', `ym/${task.id}`, { confirmed: true, force: true, forceConfirmed: true }));
  await tasks.archive('P', task.id);
  await workbench.manageBranch('P', undefined, 'delete', `ym/${task.id}`, { confirmed: true });
  await gitOk(root, ['checkout', '-b', 'unmerged']); await fs.writeFile(path.join(root, 'branch.txt'), 'topic'); await commitAll(root, 'topic');
  await gitOk(root, ['checkout', current]);
  await assert.rejects(workbench.manageBranch('P', undefined, 'delete', 'unmerged', { confirmed: true }));
  await assert.rejects(workbench.manageBranch('P', undefined, 'delete', 'unmerged', { confirmed: true, force: true }));
  assert.ok((await workbench.status('P')).branches.includes('unmerged'));
  await workbench.manageBranch('P', undefined, 'delete', 'unmerged', { confirmed: true, force: true, forceConfirmed: true });
  assert.ok(!(await workbench.status('P')).branches.includes('unmerged'));
}));

test('a task copy deleted outside the app is reported as missing, not as an internal error', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: 'copy' });
  const workdir = await new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 }).prepare('P', task.id);
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  await workbench.status('P', task.id);
  await fs.rm(workdir, { recursive: true, force: true });
  await assert.rejects(workbench.status('P', task.id), (error: unknown) => error instanceof AppError && error.status === 404 && error.detail === 'worktree_missing');
}));

test('discarding a file drops only its unstaged changes and refuses stale, secret or conflicted targets', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const file = path.join(root, 'file.txt'); const gone = path.join(root, 'gone.txt');
  await fs.writeFile(file, 'base\n'); await fs.writeFile(gone, 'keep me\n'); await commitAll(root, 'base');
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  const fingerprint = async (name: string) => (await workbench.diff('P', undefined, name, false)).fingerprint;
  const refused = (error: unknown) => error instanceof AppError && error.detail === 'git_workbench_path';
  // Staged work survives; only what is not yet staged goes back to the index version.
  await fs.writeFile(file, 'staged\n'); await workbench.stage('P', undefined, 'file.txt');
  await fs.writeFile(file, 'staged\nscratch\n');
  const seen = await fingerprint('file.txt');
  await fs.appendFile(file, 'typed after the confirmation\n');
  await assert.rejects(workbench.discard('P', undefined, 'file.txt', seen), refused);
  assert.equal(await fs.readFile(file, 'utf8'), 'staged\nscratch\ntyped after the confirmation\n');
  await workbench.discard('P', undefined, 'file.txt', await fingerprint('file.txt'));
  assert.equal(await fs.readFile(file, 'utf8'), 'staged\n');
  assert.equal(await gitOk(root, ['show', ':file.txt']), 'staged\n');
  // A tracked file deleted in the working tree comes back; an untracked file is removed.
  await fs.rm(gone);
  await workbench.discard('P', undefined, 'gone.txt', await fingerprint('gone.txt'));
  assert.equal(await fs.readFile(gone, 'utf8'), 'keep me\n');
  await fs.writeFile(path.join(root, 'scratch.txt'), 'temp\n');
  await workbench.discard('P', undefined, 'scratch.txt', await fingerprint('scratch.txt'));
  await assert.rejects(fs.access(path.join(root, 'scratch.txt')));
  // Local secrets are never deleted through the workbench, and nothing happens to a file without unstaged changes.
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=1\n');
  await assert.rejects(workbench.discard('P', undefined, '.env', 'x'.repeat(64)), refused);
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'TOKEN=1\n');
  await assert.rejects(workbench.discard('P', undefined, 'file.txt', 'x'.repeat(64)), refused);
}));

test('pull only fast-forwards and refuses diverged history or local edits upstream would overwrite', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws); await projects.create({ name: 'P' });
  const root = ws.projectDir('P'); const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  const detail = (code: string) => (error: unknown) => error instanceof AppError && error.detail === code;
  await fs.writeFile(path.join(root, 'shared.txt'), 'base\n'); await fs.writeFile(path.join(root, 'mine.txt'), 'base\n'); await commitAll(root, 'base');
  await assert.rejects(workbench.fastForward('P', undefined), detail('git_no_upstream'));
  const remote = path.join(ws.root, 'remote.git'); await fs.mkdir(remote); await gitOk(remote, ['init', '--bare', '-q']);
  const branch = (await gitOk(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
  await gitOk(root, ['remote', 'add', 'origin', remote]); await gitOk(root, ['push', '-q', '-u', 'origin', branch]);
  assert.deepEqual(await workbench.fastForward('P', undefined), { updated: false });
  const other = path.join(ws.root, 'other'); await gitOk(ws.root, ['clone', '-q', remote, other]);
  const publish = async (name: string, text: string) => { await fs.writeFile(path.join(other, name), text); await commitAll(other, name); await gitOk(other, ['push', '-q', 'origin', branch]); };
  await publish('shared.txt', 'upstream\n'); await workbench.fetch('P', undefined, 'origin');
  // An uncommitted edit to the same file is kept and the branch stays put.
  await fs.writeFile(path.join(root, 'shared.txt'), 'local draft\n');
  const head = (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
  await assert.rejects(workbench.fastForward('P', undefined), detail('git_pull_local_changes'));
  assert.equal(await fs.readFile(path.join(root, 'shared.txt'), 'utf8'), 'local draft\n');
  assert.equal((await gitOk(root, ['rev-parse', 'HEAD'])).trim(), head);
  // Edits to other files ride along with the fast-forward.
  await gitOk(root, ['checkout', '--', 'shared.txt']); await fs.writeFile(path.join(root, 'mine.txt'), 'local draft\n');
  assert.deepEqual(await workbench.fastForward('P', undefined), { updated: true });
  assert.equal((await gitOk(root, ['rev-parse', 'HEAD'])).trim(), (await gitOk(root, ['rev-parse', '@{upstream}'])).trim());
  assert.equal(await fs.readFile(path.join(root, 'shared.txt'), 'utf8'), 'upstream\n');
  assert.equal(await fs.readFile(path.join(root, 'mine.txt'), 'utf8'), 'local draft\n');
  // Once both sides have new commits there is nothing to fast-forward; no merge commit is made.
  await commitAll(root, 'local'); await publish('shared.txt', 'upstream again\n'); await workbench.fetch('P', undefined, 'origin');
  const local = (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
  await assert.rejects(workbench.fastForward('P', undefined), detail('git_not_fast_forward'));
  assert.equal((await gitOk(root, ['rev-parse', 'HEAD'])).trim(), local);
}));

test('push, fetch and commit failures name their cause instead of a generic git failure', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' }); const root = ws.projectDir('P');
  const workbench = new GitWorkbench({ ws, projects, tasks, isRunning: () => false });
  const remote = path.join(ws.root, 'remote.git'); await fs.mkdir(remote);
  await gitOk(remote, ['init', '--bare', '-q']); await gitOk(root, ['remote', 'add', 'origin', remote]);
  const cause = (detail: string) => (error: unknown) => error instanceof AppError && error.detail === detail;
  await workbench.push('P', undefined, 'origin', true);
  // Someone else pushes first: the remote is ahead of this branch.
  const other = path.join(ws.root, 'other'); await gitOk(ws.root, ['clone', '-q', remote, other]);
  const branch = (await gitOk(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
  await fs.writeFile(path.join(other, 'theirs.txt'), 'x'); await commitAll(other, 'theirs'); await gitOk(other, ['push', '-q', 'origin', `HEAD:${branch}`]);
  await fs.writeFile(path.join(root, 'mine.txt'), 'y'); await workbench.stage('P', undefined, 'mine.txt'); await workbench.commit('P', undefined, 'mine');
  await assert.rejects(workbench.push('P', undefined, 'origin', true), cause('git_push_behind'));
  // The server refuses (protected branch, server-side policy).
  await workbench.fetch('P', undefined, 'origin'); await gitOk(root, ['rebase', '-q', `origin/${branch}`]);
  await fs.writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(workbench.push('P', undefined, 'origin', true), cause('git_push_remote_rejected'));
  // Nothing answers at the configured URL.
  await gitOk(root, ['remote', 'add', 'gone', path.join(ws.root, 'missing.git')]);
  await assert.rejects(workbench.push('P', undefined, 'gone', true), cause('git_remote_unreachable'));
  await assert.rejects(workbench.fetch('P', undefined, 'gone'), cause('git_remote_unreachable'));
  // The project's own pre-commit hook refuses; the confirmed bypass still commits.
  const hooks = path.resolve(root, (await gitOk(root, ['rev-parse', '--git-path', 'hooks'])).trim()); await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'hooked.txt'), 'z'); await workbench.stage('P', undefined, 'hooked.txt');
  await assert.rejects(workbench.commit('P', undefined, 'blocked'), cause('git_hook_failed'));
  assert.match((await workbench.commit('P', undefined, 'bypassed', { bypassHooks: true, confirmed: true })).sha, /^[0-9a-f]{40}$/);
}));
