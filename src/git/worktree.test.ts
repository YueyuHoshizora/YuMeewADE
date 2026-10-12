import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { CompletionStore } from '../ledger/completion.ts';
import { AppError } from '../shared/errors.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { commitAll, git, gitOk } from './git.ts';
import { MergeConflictError, WorktreeService } from './worktree.ts';

// All fixtures exercise real repositories, linked worktrees and on-disk ledgers.
test('isolated prepare, preview, diff, merge and automatic cleanup', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '第一件' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  assert.equal(await wt.preview('P', task.id), null);
  const dir = await wt.prepare('P', task.id);
  assert.equal(await wt.prepare('P', task.id), dir);
  assert.equal((await tasks.get('P', task.id)).workdir, dir);
  await assert.rejects(fs.access(path.join(dir, '.ai')));
  await fs.writeFile(path.join(dir, 'hello.txt'), 'hi\n');
  await fs.appendFile(path.join(dir, 'AGENTS.md'), '\nchange\n');
  const preview = await wt.preview('P', task.id);
  assert.ok(preview);
  assert.equal(preview.files, 2);
  assert.equal(preview.conflict, false);
  assert.equal(preview.branch, wt.branch(task.id));
  assert.equal(preview.target, 'main');
  assert.ok(preview.paths.includes('hello.txt'));
  const diff = await wt.diff('P', task.id);
  assert.match(diff.diff, /\+hi/);
  assert.equal(diff.truncated, false);
  const result = await wt.merge('P', task.id);
  assert.equal(result.merged, true);
  assert.equal(await fs.readFile(path.join(ws.projectDir('P'), 'hello.txt'), 'utf8'), 'hi\n');
  await assert.rejects(fs.access(dir));
  assert.notEqual((await git(ws.projectDir('P'), ['rev-parse', '--verify', `refs/heads/ym/${task.id}`])).code, 0);
  const done = await tasks.get('P', task.id);
  assert.equal(done.state, '完成');
  assert.equal(done.workdir, '');
  assert.match(done.memo, /已合併到主資料夾/);
  assert.doesNotMatch(await gitOk(ws.projectDir('P'), ['ls-files']), /\.ai\//);
  assert.equal(await new CompletionStore(ws).isApproved('P', task.id), true);
  const operations = await fs.readFile(path.join(ws.internalDir, 'log.jsonl'), 'utf8');
  assert.equal(JSON.parse(operations.trim().split('\n').at(-1)!).action, 'merge');
}));

test('preview does not commit pending changes; committed conflicts abort only own merge', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const repo = ws.projectDir('P');
  await fs.writeFile(path.join(repo, 'content.txt'), 'base\n');
  await commitAll(repo, 'base');
  const task = await tasks.create('P', { title: '衝突' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  const before = await gitOk(dir, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(dir, 'content.txt'), 'copy\n');
  await wt.preview('P', task.id);
  assert.equal(await gitOk(dir, ['rev-parse', 'HEAD']), before);
  await commitAll(dir, 'copy');
  await fs.writeFile(path.join(repo, 'content.txt'), 'main\n');
  await commitAll(repo, 'main');
  const preview = await wt.preview('P', task.id);
  assert.equal(preview?.conflict, true);
  assert.deepEqual(preview?.conflictPaths, ['content.txt']);
  await assert.rejects(wt.merge('P', task.id), (error: unknown) => error instanceof MergeConflictError && error.toJSON().conflicts[0] === 'content.txt');
  assert.equal(await fs.readFile(path.join(repo, 'content.txt'), 'utf8'), 'main\n');
  assert.equal(await gitOk(repo, ['status', '--porcelain']), '');
  assert.notEqual((await git(repo, ['rev-parse', '--verify', 'MERGE_HEAD'])).code, 0);
  const record = await tasks.get('P', task.id);
  assert.equal(record.state, '等待回覆');
  assert.match(record.question, /先把主資料夾的最新內容合進副本/);
  assert.equal(record.workdir, dir);
  // A manually started merge must remain untouched.
  await git(repo, ['merge', '--no-ff', `ym/${task.id}`]);
  const mergeHead = await gitOk(repo, ['rev-parse', 'MERGE_HEAD']);
  await assert.rejects(wt.merge('P', task.id), (e: unknown) => e instanceof AppError && e.detail === 'merge_in_progress');
  assert.equal(await gitOk(repo, ['rev-parse', 'MERGE_HEAD']), mergeHead);
  await gitOk(repo, ['merge', '--abort']);
}));

test('already merged is approved and cleans worktree without another commit', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '沒有新變更' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100 });
  await wt.prepare('P', task.id);
  const head = await gitOk(ws.projectDir('P'), ['rev-parse', 'HEAD']);
  const result = await wt.merge('P', task.id);
  assert.equal(result.already, true);
  assert.equal(await gitOk(ws.projectDir('P'), ['rev-parse', 'HEAD']), head);
  assert.equal((await tasks.get('P', task.id)).state, '完成');
}));

test('external non-repo is initialized, secrets copied but never newly committed', () => withTmpWorkspace(async (ws, tmp) => {
  const body = path.join(tmp, 'external');
  await fs.mkdir(path.join(body, 'nested'), { recursive: true });
  await fs.writeFile(path.join(body, 'app.txt'), 'app\n');
  await fs.writeFile(path.join(body, '.env.local'), 'SECRET=one\n');
  await fs.writeFile(path.join(body, 'nested', '.npmrc'), 'TOKEN=two\n');
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P', body });
  const task = await tasks.create('P', { title: '外部' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  assert.equal(await fs.readFile(path.join(dir, '.env.local'), 'utf8'), 'SECRET=one\n');
  assert.equal(await fs.readFile(path.join(dir, 'nested', '.npmrc'), 'utf8'), 'TOKEN=two\n');
  assert.doesNotMatch(await gitOk(body, ['ls-files']), /\.env|\.npmrc/);
  assert.equal((await wt.preview('P', task.id))?.files, 0);
  assert.doesNotMatch((await wt.diff('P', task.id)).diff, /SECRET|TOKEN/);
  await fs.writeFile(path.join(dir, 'app.txt'), 'changed\n');
  await wt.merge('P', task.id);
  assert.equal(await fs.readFile(path.join(body, 'app.txt'), 'utf8'), 'changed\n');
  assert.doesNotMatch(await gitOk(body, ['ls-files']), /\.env|\.npmrc/);
}));

test('direct saves tracked edits, preserves tracked secrets and excludes new secrets', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const repo = ws.projectDir('P');
  await fs.writeFile(path.join(repo, '.env.tracked'), 'old\n');
  await gitOk(repo, ['add', '-f', '.env.tracked']);
  await gitOk(repo, ['commit', '--no-verify', '-m', 'tracked configuration']);
  await fs.writeFile(path.join(repo, '.env.tracked'), 'updated\n');
  await fs.writeFile(path.join(repo, '.dev.vars.new'), 'never\n');
  const task = await tasks.create('P', { title: '直接', workspace: 'direct' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100 });
  assert.equal(await wt.prepare('P', task.id), repo);
  assert.equal(await gitOk(repo, ['show', 'HEAD:.env.tracked']), 'updated\n');
  assert.doesNotMatch(await gitOk(repo, ['ls-files']), /\.dev.vars.new/);
  assert.equal((await tasks.get('P', task.id)).workdir, '');
}));

test('autosave never commits a new secret that differs only in case or arrives by renaming a tracked file', () => withTmpWorkspace(async ws => {
  const repo = path.join(ws.root, 'repo'); await fs.mkdir(path.join(repo, 'nested'), { recursive: true });
  await gitOk(repo, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(repo, 'config.txt'), 'TOKEN=example\n'); await fs.writeFile(path.join(repo, 'file*.txt'), 'glob-looking\n');
  assert.equal(await commitAll(repo, 'base'), true);
  // Same bytes under a secret name: Git's rename detection would otherwise report the secret as R, not A.
  await fs.rename(path.join(repo, 'config.txt'), path.join(repo, '.env.local'));
  for (const name of ['nested/.ENV.local', 'nested/.NPMRC', 'nested/.DEV.VARS.prod']) await fs.writeFile(path.join(repo, name), 'TOKEN=secret\n');
  await fs.writeFile(path.join(repo, 'file*.txt'), 'changed\n');
  assert.equal(await commitAll(repo, 'autosave'), true);
  assert.deepEqual((await gitOk(repo, ['ls-files'])).trim().split('\n'), ['file*.txt']);
  assert.equal(await gitOk(repo, ['show', 'HEAD:file*.txt']), 'changed\n');
  for (const name of ['.env.local', 'nested/.ENV.local', 'nested/.NPMRC', 'nested/.DEV.VARS.prod']) assert.equal(await fs.readFile(path.join(repo, name), 'utf8'), name === '.env.local' ? 'TOKEN=example\n' : 'TOKEN=secret\n');
}));

test('exclusion, stale copyclear, missing merge and bounded diff', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '清除' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 50 });
  const dir = await wt.prepare('P', task.id);
  await wt.exclusion('P', task.id, true);
  assert.equal(await wt.preview('P', task.id), null);
  await assert.rejects(wt.merge('P', task.id), (e: unknown) => e instanceof AppError && e.detail === 'merge_excluded');
  await wt.exclusion('P', task.id, false);
  await fs.writeFile(path.join(dir, 'large.txt'), 'x'.repeat(1000));
  const diff = await wt.diff('P', task.id);
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.diff) <= 50);
  await assert.rejects(wt.copyclear('P', task.id), (e: unknown) => e instanceof AppError && e.detail === 'worktree_exists');
  await gitOk(ws.projectDir('P'), ['worktree', 'remove', '--force', dir]);
  await assert.rejects(wt.merge('P', task.id), (e: unknown) => e instanceof AppError && e.detail === 'worktree_missing');
  assert.equal((await tasks.get('P', task.id)).workdir, '');
  assert.equal((await wt.copyclear('P', task.id)).workdir, '');
}));

test('merge preserves excluded secrets and reports relative leftover paths', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '保留設定' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100 });
  const dir = await wt.prepare('P', task.id);
  await fs.appendFile(path.join(dir, '.gitignore'), '\n!.env.local\n');
  await fs.writeFile(path.join(dir, 'new.txt'), 'merged\n');
  await fs.writeFile(path.join(dir, '.env.local'), 'SECRET=keep\n');
  const result = await wt.merge('P', task.id);
  assert.equal(result.merged, true);
  assert.deepEqual(result.leftover, ['.env.local']);
  assert.equal(await fs.readFile(path.join(dir, '.env.local'), 'utf8'), 'SECRET=keep\n');
  assert.equal(await fs.readFile(path.join(ws.projectDir('P'), 'new.txt'), 'utf8'), 'merged\n');
  assert.equal((await tasks.get('P', task.id)).workdir, dir);
  assert.equal((await tasks.get('P', task.id)).state, '完成');
  assert.equal(await new CompletionStore(ws).isApproved('P', task.id), true);
  assert.equal((await git(ws.projectDir('P'), ['rev-parse', '--verify', `refs/heads/ym/${task.id}`])).code, 0);
}));

test('concurrent merges serialize across service instances and reject the cleaned copy', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '同時合併' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100 });
  const other = new WorktreeService({ ws, projects, tasks, diffBytes: 100 });
  const dir = await wt.prepare('P', task.id);
  await fs.writeFile(path.join(dir, 'new.txt'), 'once\n');
  const results = await Promise.allSettled([wt.merge('P', task.id), other.merge('P', task.id)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.ok(rejected.reason instanceof AppError);
  assert.equal(rejected.reason.detail, 'worktree_missing');
  assert.equal(await fs.readFile(path.join(ws.projectDir('P'), 'new.txt'), 'utf8'), 'once\n');
  const operations = (await fs.readFile(path.join(ws.internalDir, 'log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { action: string });
  assert.equal(operations.filter(entry => entry.action === 'merge').length, 1);
}));

test('restore returns the copy to a checkpoint and keeps local secrets', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '還原' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  const first = await wt.checkpoint('P', task.id);
  assert.match(first ?? '', /^[0-9a-f]{40}$/);
  assert.equal(await wt.checkpoint('P', task.id), first, 'no changes → same commit');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1\n');
  await fs.writeFile(path.join(dir, 'a.txt'), 'two\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'new\n');
  await gitOk(dir, ['add', '-A']);
  await gitOk(dir, ['commit', '-q', '-m', 'ai commit']);
  await fs.writeFile(path.join(dir, 'c.txt'), 'untracked\n');
  await wt.restore('P', task.id, first!);
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\n');
  await assert.rejects(fs.access(path.join(dir, 'b.txt')));
  await assert.rejects(fs.access(path.join(dir, 'c.txt')));
  assert.equal(await fs.readFile(path.join(dir, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal((await gitOk(dir, ['rev-parse', 'HEAD'])).trim(), first);
  await assert.rejects(wt.restore('P', task.id, 'f'.repeat(40)), (e: unknown) => e instanceof AppError && e.detail === 'checkpoint_missing');
  await assert.rejects(wt.restore('P', task.id, 'not-a-sha'), (e: unknown) => e instanceof AppError && e.detail === 'checkpoint_missing');
}));

test('finishTurn summarizes one turn and rangeDiff shows only that turn', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '單輪' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  const start1 = (await wt.checkpoint('P', task.id))!;
  await fs.writeFile(path.join(dir, 'one.txt'), 'a\nb\n');
  const turn1 = (await wt.finishTurn('P', task.id, start1))!;
  assert.deepEqual(turn1.changes, { files: 1, added: 2, removed: 0 });
  const start2 = (await wt.checkpoint('P', task.id))!;
  assert.equal(start2, turn1.after, 'next turn starts exactly where the last ended');
  const idle = (await wt.finishTurn('P', task.id, start2))!;
  assert.equal(idle.changes, undefined);
  await fs.writeFile(path.join(dir, 'one.txt'), 'a\n');
  await fs.writeFile(path.join(dir, 'two.txt'), 'x\n');
  const turn2 = (await wt.finishTurn('P', task.id, start2))!;
  assert.deepEqual(turn2.changes, { files: 2, added: 1, removed: 1 });
  const only2 = await wt.rangeDiff('P', task.id, start2, turn2.after);
  assert.match(only2.diff, /two\.txt/);
  assert.doesNotMatch(only2.diff, /\+b/);
  assert.equal(only2.truncated, false);
  await assert.rejects(wt.rangeDiff('P', task.id, start2, 'e'.repeat(40)), (e: unknown) => e instanceof AppError && e.detail === 'checkpoint_missing');
  await assert.rejects(wt.finishTurn('P', task.id, '--bad'), (e: unknown) => e instanceof AppError && e.detail === 'checkpoint_missing');
}));

test('preview lists other tasks whose copies touch the same files', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const [a, b, c] = [await tasks.create('P', { title: 'A' }), await tasks.create('P', { title: 'B' }), await tasks.create('P', { title: 'C' })];
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const [dirA, dirB, dirC] = [await wt.prepare('P', a.id), await wt.prepare('P', b.id), await wt.prepare('P', c.id)];
  await fs.writeFile(path.join(dirA, 'shared.txt'), 'a\n');
  await fs.writeFile(path.join(dirA, 'only-a.txt'), 'a\n');
  await fs.writeFile(path.join(dirB, 'shared.txt'), 'b\n');
  await fs.writeFile(path.join(dirC, 'only-c.txt'), 'c\n');
  const preview = await wt.preview('P', a.id);
  assert.deepEqual(preview?.overlaps, [{ task: b.id, title: 'B', paths: ['shared.txt'] }]);
  await wt.exclusion('P', b.id, true);
  assert.deepEqual((await wt.preview('P', a.id))?.overlaps, []);
}));

test('unmerge rewinds the main folder and revives the copy, but only while the merge is the latest commit and main is clean', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '可撤銷' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const repo = ws.projectDir('P');
  assert.equal(await wt.mergedInfo('P', task.id), null, 'nothing merged yet');
  const dir = await wt.prepare('P', task.id);
  await fs.writeFile(path.join(dir, 'feature.txt'), 'feature\n');
  const before = (await gitOk(repo, ['rev-parse', 'HEAD'])).trim();
  const merged = await wt.merge('P', task.id);
  assert.equal((await wt.mergedInfo('P', task.id))?.commit, merged.commit);
  assert.equal(await fs.readFile(path.join(repo, 'feature.txt'), 'utf8'), 'feature\n');

  await fs.writeFile(path.join(repo, 'scratch.txt'), 'uncommitted\n');
  await assert.rejects(wt.unmerge('P', task.id), (e: unknown) => e instanceof AppError && e.detail === 'unmerge_unavailable');
  await fs.rm(path.join(repo, 'scratch.txt'));

  const revived = await wt.unmerge('P', task.id);
  assert.equal(revived.state, '進行中');
  assert.equal((await gitOk(repo, ['rev-parse', 'HEAD'])).trim(), before);
  await assert.rejects(fs.access(path.join(repo, 'feature.txt')));
  assert.equal(await fs.readFile(path.join(revived.workdir, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(await new CompletionStore(ws).isApproved('P', task.id), false);
  assert.equal(await wt.mergedInfo('P', task.id), null);

  // Merge again, then let somebody commit on top: the merge is no longer the latest commit.
  await wt.merge('P', task.id);
  await fs.writeFile(path.join(repo, 'later.txt'), 'later\n');
  await commitAll(repo, '之後的修改');
  assert.equal(await wt.mergedInfo('P', task.id), null);
  await assert.rejects(wt.unmerge('P', task.id), (e: unknown) => e instanceof AppError && e.detail === 'unmerge_unavailable');
  assert.equal(await fs.readFile(path.join(repo, 'later.txt'), 'utf8'), 'later\n');
}));

test('prepareFrom grows a new copy from a checkpoint without touching the main folder', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '原作業' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  await fs.writeFile(path.join(dir, 'early.txt'), 'early\n');
  const point = (await wt.checkpoint('P', task.id))!;
  await fs.writeFile(path.join(dir, 'late.txt'), 'late\n');
  await wt.checkpoint('P', task.id);
  const repo = ws.projectDir('P');
  await fs.writeFile(path.join(repo, 'main-only.txt'), 'dirty main\n');
  const forked = await tasks.create('P', { title: '分支', kind: 'derived', derivedFrom: task.id });
  const copy = await wt.prepareFrom('P', forked.id, point);
  assert.equal(await fs.readFile(path.join(copy, 'early.txt'), 'utf8'), 'early\n');
  await assert.rejects(fs.access(path.join(copy, 'late.txt')));
  await assert.rejects(fs.access(path.join(copy, 'main-only.txt')), 'uncommitted main changes are neither committed nor copied');
  assert.equal((await gitOk(repo, ['status', '--porcelain'])).trim(), '?? main-only.txt', 'main folder untouched');
  assert.equal((await tasks.get('P', forked.id)).workdir, copy);
  assert.equal((await gitOk(copy, ['rev-parse', 'HEAD'])).trim(), point);
  await assert.rejects(wt.prepareFrom('P', forked.id, 'a'.repeat(40)), (e: unknown) => e instanceof AppError && e.detail === 'checkpoint_missing');
  await assert.rejects(wt.prepareFrom('P', forked.id, 'bad'), (e: unknown) => e instanceof AppError && e.detail === 'checkpoint_missing');
}));

test('file viewing lists tracked and new files, hides secrets, and refuses anything outside the copy', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '看檔' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  assert.ok((await wt.listFiles('P', task.id)).includes('AGENTS.md'), 'before a copy exists the main folder is shown');
  const dir = await wt.prepare('P', task.id);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1\n');
  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  await fs.writeFile(path.join(dir, 'big.txt'), 'x'.repeat(300 * 1024));
  const outside = path.join(ws.root, 'outside.txt');
  await fs.writeFile(outside, 'private\n');
  await fs.symlink(outside, path.join(dir, 'link.txt'));
  const files = await wt.listFiles('P', task.id);
  assert.ok(files.includes('src/a.ts') && files.includes('AGENTS.md'));
  assert.ok(!files.includes('.env'), 'local secrets are never listed');
  assert.deepEqual(await wt.readFile('P', task.id, 'src/a.ts'), { path: 'src/a.ts', size: 20, truncated: false, binary: false, text: 'export const a = 1;\n' });
  assert.equal((await wt.readFile('P', task.id, 'blob.bin')).binary, true);
  const big = await wt.readFile('P', task.id, 'big.txt');
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, 256 * 1024);
  for (const bad of ['.env', '../outside.txt', '/etc/hosts', 'link.txt', 'nope.txt', 'src']) {
    await assert.rejects(wt.readFile('P', task.id, bad), (e: unknown) => e instanceof AppError && e.detail === 'file_missing', bad);
  }
}));

test('revertFile restores one file to the fork point and only touches files that really changed', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '還原單檔' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  const original = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
  await fs.appendFile(path.join(dir, 'AGENTS.md'), '\nAI 亂改的\n');
  await fs.writeFile(path.join(dir, 'keep.txt'), 'keep\n');
  await fs.writeFile(path.join(dir, 'committed-new.txt'), 'ai\n');
  await wt.checkpoint('P', task.id); // AI work is committed on the branch, like after a turn
  await fs.writeFile(path.join(dir, 'untracked-new.txt'), 'ai\n');
  await fs.rm(path.join(dir, 'CLAUDE.md'));

  await wt.revertFile('P', task.id, 'AGENTS.md');
  assert.equal(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'), original);
  await wt.revertFile('P', task.id, 'committed-new.txt');
  await assert.rejects(fs.access(path.join(dir, 'committed-new.txt')));
  await wt.revertFile('P', task.id, 'untracked-new.txt');
  await assert.rejects(fs.access(path.join(dir, 'untracked-new.txt')));
  await wt.revertFile('P', task.id, 'CLAUDE.md');
  await fs.access(path.join(dir, 'CLAUDE.md'));

  const preview = await wt.preview('P', task.id);
  assert.deepEqual(preview?.paths, ['keep.txt'], 'only the untouched-by-revert file is still a change');
  assert.equal(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8'), 'keep\n');
  for (const bad of ['PROJECT.md', 'nope.txt', '../outside', '/etc/hosts', '']) {
    await assert.rejects(wt.revertFile('P', task.id, bad), (e: unknown) => e instanceof AppError && e.detail === 'file_missing', bad);
  }
}));

test('checkpoint secret copying refuses destination directory and file symlinks', () => withTmpWorkspace(async (ws, tmp) => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const repo = ws.projectDir('P');
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const original = await tasks.create('P', { title: '不安全檢查點' });
  const source = await wt.prepare('P', original.id);
  const outside = path.join(tmp, 'outside');
  await fs.mkdir(outside);
  const sentinel = path.join(outside, 'sentinel');
  await fs.writeFile(sentinel, 'unchanged\n');
  await fs.symlink(sentinel, path.join(source, '.env.local'));
  await gitOk(source, ['add', '-f', '.env.local']);
  await gitOk(source, ['commit', '-q', '-m', 'checkpoint file symlink']);
  const leafPoint = (await gitOk(source, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(repo, '.env.local'), 'SECRET=never-outside\n');
  const leaf = await tasks.create('P', { title: '檔案連結' });
  await assert.rejects(wt.prepareFrom('P', leaf.id, leafPoint), (error: unknown) => error instanceof AppError && error.detail === 'archive_unsafe_path');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged\n');
  await fs.rm(path.join(repo, '.env.local'));

  await fs.symlink(outside, path.join(source, 'nested'));
  await gitOk(source, ['add', 'nested']);
  await gitOk(source, ['commit', '-q', '-m', 'checkpoint directory symlink']);
  const parentPoint = (await gitOk(source, ['rev-parse', 'HEAD'])).trim();
  await fs.mkdir(path.join(repo, 'nested'));
  await fs.writeFile(path.join(repo, 'nested', '.npmrc'), 'TOKEN=never-outside\n');
  const parent = await tasks.create('P', { title: '資料夾連結' });
  await assert.rejects(wt.prepareFrom('P', parent.id, parentPoint), (error: unknown) => error instanceof AppError && error.detail === 'archive_unsafe_path');
  await assert.rejects(fs.access(path.join(outside, '.npmrc')));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged\n');
}));

test('merge preserves ignored unique files and local secrets as reported leftovers', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const repo = ws.projectDir('P');
  await fs.writeFile(path.join(repo, '.gitignore'), 'cache/\n.env*\n');
  await commitAll(repo, 'ignore local files');
  const task = await tasks.create('P', { title: '保留忽略檔' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  await fs.mkdir(path.join(dir, 'cache'));
  await fs.writeFile(path.join(dir, 'cache', 'unique.bin'), 'unique\n');
  await fs.writeFile(path.join(dir, '.env.local'), 'SECRET=unique\n');
  await fs.writeFile(path.join(dir, 'feature.txt'), 'published\n');
  const result = await wt.merge('P', task.id);
  assert.ok(result.leftover?.some(file => file === 'cache/' || file === 'cache/unique.bin'));
  assert.ok(result.leftover?.includes('.env.local'));
  assert.equal((await tasks.get('P', task.id)).workdir, dir);
  assert.equal(await fs.readFile(path.join(dir, 'cache', 'unique.bin'), 'utf8'), 'unique\n');
  assert.equal(await fs.readFile(path.join(dir, '.env.local'), 'utf8'), 'SECRET=unique\n');
  assert.equal(await fs.readFile(path.join(repo, 'feature.txt'), 'utf8'), 'published\n');
  await assert.rejects(fs.access(path.join(repo, 'cache', 'unique.bin')));
  await assert.rejects(fs.access(path.join(repo, '.env.local')));
}));

test('revive overlays dead-registration tracked modifications, late writes and deletions', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const repo = ws.projectDir('P');
  await fs.writeFile(path.join(repo, 'modified.txt'), 'base\n');
  await fs.writeFile(path.join(repo, 'late.txt'), 'base\n');
  await fs.writeFile(path.join(repo, 'deleted.txt'), 'base\n');
  await fs.mkdir(path.join(repo, 'removed'));
  await fs.writeFile(path.join(repo, 'removed', 'child.txt'), 'base\n');
  await commitAll(repo, 'tracked recovery baseline');
  const task = await tasks.create('P', { title: '失效登記' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  const gitdir = (await gitOk(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  await fs.writeFile(path.join(dir, 'modified.txt'), 'uncommitted tracked change\n');
  await fs.rm(path.join(dir, 'deleted.txt'));
  await fs.rm(path.join(dir, 'removed'), { recursive: true });
  const late = await fs.open(path.join(dir, 'late.txt'), 'r+');
  try {
    await fs.rm(gitdir, { recursive: true });
    await wt.abandon('P', task.id);
    await late.truncate(0);
    await late.writeFile('late tracked write after retention\n');
  } finally { await late.close(); }
  await wt.revive('P', task.id);
  assert.equal((await tasks.get('P', task.id)).workdir, dir);
  assert.equal(await fs.readFile(path.join(dir, 'modified.txt'), 'utf8'), 'uncommitted tracked change\n');
  assert.equal(await fs.readFile(path.join(dir, 'late.txt'), 'utf8'), 'late tracked write after retention\n');
  await assert.rejects(fs.access(path.join(dir, 'deleted.txt')));
  await assert.rejects(fs.access(path.join(dir, 'removed')));
  assert.equal(await fs.readFile(path.join(repo, 'modified.txt'), 'utf8'), 'base\n');
  assert.equal(await fs.readFile(path.join(repo, 'deleted.txt'), 'utf8'), 'base\n');
  await fs.access(path.join(gitdir, 'HEAD'));
  assert.equal((await gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), wt.branch(task.id));
  const status = await gitOk(dir, ['status', '--porcelain']);
  assert.match(status, /modified\.txt/);
  assert.match(status, /late\.txt/);
  assert.match(status, /deleted\.txt/);
}));

test('revive refuses a preexisting user checkout without overwriting it', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '還原衝突' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const dir = await wt.prepare('P', task.id);
  await fs.writeFile(path.join(dir, 'unique.txt'), 'retained\n');
  await wt.abandon('P', task.id);
  await gitOk(ws.projectDir('P'), ['worktree', 'add', '-q', dir, wt.branch(task.id)]);
  await fs.writeFile(path.join(dir, 'unique.txt'), 'user checkout change\n');
  const registration = await fs.readFile(path.join(dir, '.git'), 'utf8');
  await assert.rejects(wt.revive('P', task.id), (error: unknown) => error instanceof AppError && error.detail === 'archive_restore_conflict');
  assert.equal(await fs.readFile(path.join(dir, 'unique.txt'), 'utf8'), 'user checkout change\n');
  assert.equal(await fs.readFile(path.join(dir, '.git'), 'utf8'), registration);
}));

test('maintenance classifies main, active, archived, orphan, locked and missing copies safely', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const task = await tasks.create('P', { title: 'active' });
  const active = await wt.prepare('P', task.id), repo = ws.projectDir('P');
  const orphan = ws.worktreeDir('P', 'T999'), missing = ws.worktreeDir('P', 'T998');
  const locked = ws.worktreeDir('P', 'T997');
  for (const dir of [orphan, missing, locked]) await gitOk(repo, ['worktree', 'add', '--detach', dir, 'HEAD']);
  await gitOk(repo, ['worktree', 'lock', locked]);
  await fs.rm(missing, { recursive: true });
  let entries = await wt.maintenance('P');
  assert.equal(entries.find(entry => entry.path === repo)?.kind, 'main');
  assert.equal(entries.find(entry => entry.path === active)?.kind, 'active');
  assert.equal(entries.find(entry => entry.path === active)?.removable, false);
  assert.equal(entries.find(entry => entry.path === missing)?.prunable, true);
  assert.equal(entries.find(entry => entry.path === locked)?.locked, true);
  assert.equal(entries.find(entry => entry.path === orphan)?.removable, true);
  await assert.rejects(wt.removeStale('P', active));
  await assert.rejects(wt.removeStale('P', repo));
  await assert.rejects(wt.removeStale('P', locked));
  await fs.writeFile(path.join(orphan, 'dirty.txt'), 'keep');
  await assert.rejects(wt.removeStale('P', orphan));
  assert.equal(await fs.readFile(path.join(orphan, 'dirty.txt'), 'utf8'), 'keep');
  await fs.rm(path.join(orphan, 'dirty.txt'));
  await fs.writeFile(path.join(orphan, '.env'), 'ignored secret');
  assert.equal((await wt.maintenance('P')).find(entry => entry.path === orphan)?.dirty, true);
  await assert.rejects(wt.removeStale('P', orphan));
  await fs.rm(path.join(orphan, '.env'));
  const trash = path.join(ws.projectDir('P'), '.ai', 'trash', `${task.id}-abc`);
  await fs.mkdir(trash, { recursive: true });
  await fs.rename(ws.taskFile('P', task.id), path.join(trash, `${task.id}.md`));
  entries = await wt.maintenance('P');
  assert.equal(entries.find(entry => entry.path === active)?.kind, 'archived');
  await wt.removeStale('P', active);
  await wt.removeStale('P', orphan);
  const preview = await wt.prunePreview('P');
  assert.ok(preview.includes(path.basename(missing)));
  await assert.rejects(wt.pruneStale('P', 'outdated preview'));
  await wt.pruneStale('P', preview);
  assert.equal((await wt.maintenance('P')).some(entry => entry.path === missing), false);
}));

test('maintenance refuses pruning a missing active task copy', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const task = await tasks.create('P', { title: 'active' });
  const dir = await wt.prepare('P', task.id);
  await fs.rm(dir, { recursive: true });
  await assert.rejects(wt.pruneStale('P', await wt.prunePreview('P')));
  assert.equal((await wt.maintenance('P')).find(entry => entry.path === dir)?.kind, 'active');
}));

test('automatic saves never conclude a merge or rebase the user left unfinished', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  const tasks = new TaskLedger(ws);
  await projects.create({ name: 'P' });
  const repo = ws.projectDir('P');
  await fs.writeFile(path.join(repo, 'content.txt'), 'base\n'); await commitAll(repo, 'base');
  const main = (await gitOk(repo, ['symbolic-ref', '--short', 'HEAD'])).trim();
  await gitOk(repo, ['checkout', '-q', '-b', 'topic']); await fs.writeFile(path.join(repo, 'content.txt'), 'topic\n'); await commitAll(repo, 'topic');
  await gitOk(repo, ['checkout', '-q', main]); await fs.writeFile(path.join(repo, 'content.txt'), 'main\n'); await commitAll(repo, 'main');
  const wt = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  const inProgress = (error: unknown) => error instanceof AppError && error.detail === 'git_operation_in_progress';
  for (const start of [['merge', 'topic'], ['rebase', 'topic']]) {
    assert.notEqual((await git(repo, ['-c', 'core.editor=true', ...start])).code, 0);
    const head = (await gitOk(repo, ['rev-parse', 'HEAD'])).trim();
    // An isolated task branches from the main folder; saving it now would commit the conflict markers.
    const isolated = await tasks.create('P', { title: `isolated ${start[0]}` });
    await assert.rejects(wt.prepare('P', isolated.id), inProgress);
    // Working directly in the main folder (e.g. asking the AI to resolve it) still starts, without a save.
    const direct = await tasks.create('P', { title: `direct ${start[0]}`, workspace: 'direct' });
    assert.equal(await wt.prepare('P', direct.id), repo);
    assert.equal((await gitOk(repo, ['rev-parse', 'HEAD'])).trim(), head);
    assert.match(await fs.readFile(path.join(repo, 'content.txt'), 'utf8'), /^<<<<<<< /m);
    await gitOk(repo, [start[0]!, '--abort']);
  }
  // A task copy left mid-merge by the AI skips the turn checkpoint instead of blocking the next turn.
  const task = await tasks.create('P', { title: 'copy' });
  const dir = await wt.prepare('P', task.id);
  await fs.writeFile(path.join(dir, 'content.txt'), 'copy\n'); await commitAll(dir, 'copy');
  assert.notEqual((await git(dir, ['merge', 'topic'])).code, 0);
  const copyHead = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
  assert.equal(await wt.checkpoint('P', task.id), undefined);
  assert.equal((await gitOk(dir, ['rev-parse', 'HEAD'])).trim(), copyHead);
  assert.equal((await git(dir, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])).code, 0);
}));
