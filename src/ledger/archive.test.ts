import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { commitAll, git, gitOk } from '../git/git.ts';
import { WorktreeService } from '../git/worktree.ts';
import { RecoveryStore } from '../git/recovery.ts';
import { ProjectLedger } from './projects.ts';
import { TaskLedger } from './tasks.ts';
import { ArchiveService } from './archive.ts';
import type { Workspace } from './workspace.ts';

function services(ws: Workspace) {
  const projects = new ProjectLedger(ws), tasks = new TaskLedger(ws);
  const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
  return { projects, tasks, worktree, archive: new ArchiveService(ws, projects, tasks, worktree) };
}

test('force archive and restore retain fake secrets, ignored files, ordinary changes and conversations', () => withTmpWorkspace(async ws => {
  const { projects, tasks, worktree, archive } = services(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '保存資料' });
  const dir = await worktree.prepare('P', task.id);
  // Staged by hand: the archive commit still drops a new secret from Git, so the preview must not promise Git keeps it.
  await fs.writeFile(path.join(dir, '.env.audit'), 'FAKE_ONLY=yes\n'); await gitOk(dir, ['add', '-f', '.env.audit']);
  await fs.appendFile(path.join(dir, '.gitignore'), '\nignored.bin\n');
  await fs.writeFile(path.join(dir, 'ignored.bin'), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(dir, 'ordinary.txt'), 'normal change\n');
  const chat = '{"role":"user","text":"retained conversation"}\n';
  await fs.writeFile(ws.chatFile('P', task.id, 'jsonl'), chat);
  const preview = await archive.preview('P', task.id);
  assert.ok(preview.git.includes('ordinary.txt'));
  assert.ok(preview.preserved.includes('.env.audit'));
  assert.ok(preview.preserved.includes('ignored.bin'));
  assert.deepEqual(preview.unavailable, []);
  await worktree.abandon('P', task.id);
  await assert.rejects(fs.access(dir));
  assert.notEqual((await git(ws.projectDir('P'), ['show', `ym/${task.id}:.env.audit`])).code, 0);
  assert.equal(await gitOk(ws.projectDir('P'), ['show', `ym/${task.id}:ordinary.txt`]), 'normal change\n');
  const recovery = path.join(ws.internalDir, 'recovery');
  assert.equal((await fs.stat(recovery)).mode & 0o777, 0o700);
  await tasks.archive('P', task.id);
  const [entry] = await archive.list('P');
  assert.ok(entry);
  await archive.restore(entry.key, 'P');
  assert.equal((await tasks.get('P', task.id)).workdir, dir);
  assert.equal(await fs.readFile(path.join(dir, '.env.audit'), 'utf8'), 'FAKE_ONLY=yes\n');
  assert.deepEqual(await fs.readFile(path.join(dir, 'ignored.bin')), Buffer.from([0, 1, 2, 255]));
  assert.equal(await fs.readFile(path.join(dir, 'ordinary.txt'), 'utf8'), 'normal change\n');
  assert.equal(await fs.readFile(ws.chatFile('P', task.id, 'jsonl'), 'utf8'), chat);
  assert.equal((await gitOk(dir, ['symbolic-ref', '--short', 'HEAD'])).trim(), `ym/${task.id}`);
  assert.equal(await worktree.prepare('P', task.id), dir);
}));

test('recovery failure refuses removal and leaves original copy intact', () => withTmpWorkspace(async ws => {
  const { projects, tasks, worktree } = services(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '拒絕不安全保存' });
  const dir = await worktree.prepare('P', task.id);
  await fs.writeFile(path.join(dir, '.env.audit'), 'FAKE_ONLY=keep\n');
  await fs.symlink(ws.projectsDir, path.join(ws.internalDir, 'recovery'));
  await assert.rejects(worktree.abandon('P', task.id));
  assert.equal(await fs.readFile(path.join(dir, '.env.audit'), 'utf8'), 'FAKE_ONLY=keep\n');
  assert.equal((await tasks.get('P', task.id)).workdir, dir);
}));

test('dead git registration leftovers are retained rather than deleted', () => withTmpWorkspace(async ws => {
  const { projects, tasks, worktree, archive } = services(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '移除中斷' });
  const dir = await worktree.prepare('P', task.id);
  await fs.writeFile(path.join(dir, '.env.audit'), 'FAKE_ONLY=leftover\n');
  const pointer = await fs.readFile(path.join(dir, '.git'), 'utf8');
  const registration = pointer.trim().replace(/^gitdir:\s*/, '');
  await fs.rm(path.resolve(dir, registration), { recursive: true });
  await worktree.abandon('P', task.id);
  await tasks.archive('P', task.id);
  const [entry] = await archive.list('P');
  await archive.restore(entry!.key, 'P');
  assert.equal(await fs.readFile(path.join(dir, '.env.audit'), 'utf8'), 'FAKE_ONLY=leftover\n');
}));

test('corrupt git pointer refuses archive without deleting the copy', () => withTmpWorkspace(async ws => {
  const { projects, tasks, worktree } = services(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '壞登記' });
  const dir = await worktree.prepare('P', task.id);
  await fs.writeFile(path.join(dir, '.git'), 'corrupt registration\n');
  await fs.writeFile(path.join(dir, '.env.audit'), 'FAKE_ONLY=keep\n');
  await assert.rejects(worktree.abandon('P', task.id));
  assert.equal(await fs.readFile(path.join(dir, '.env.audit'), 'utf8'), 'FAKE_ONLY=keep\n');
}));

test('project archive/restore never moves external body code and restores task ledger', () => withTmpWorkspace(async ws => {
  const { projects, tasks, archive } = services(ws);
  const external = path.join(ws.root, 'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'code.txt'), 'external code\n');
  await projects.create({ name: 'P', body: external });
  const task = await tasks.create('P', { title: '直接作業', workspace: 'direct' });
  await projects.archive('P');
  assert.equal(await fs.readFile(path.join(external, 'code.txt'), 'utf8'), 'external code\n');
  const [entry] = await archive.list();
  assert.equal(entry!.body, external);
  await archive.restore(entry!.key);
  assert.equal((await projects.get('P')).body, external);
  assert.equal((await tasks.get('P', task.id)).title, '直接作業');
}));

test('restore name and destination conflicts never overwrite and temporary leftovers are not archives', () => withTmpWorkspace(async ws => {
  const { projects, tasks, archive } = services(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: '衝突' });
  await tasks.archive('P', task.id);
  const [entry] = await archive.list('P');
  await fs.writeFile(ws.taskFile('P', task.id), 'existing destination\n');
  await assert.rejects(archive.restore(entry!.key, 'P'));
  assert.equal(await fs.readFile(ws.taskFile('P', task.id), 'utf8'), 'existing destination\n');
  assert.equal((await archive.list('P')).length, 1);
  await fs.mkdir(path.join(ws.projectDir('P'), '.ai', 'trash', '.leftover.tmp'));
  await fs.mkdir(path.join(ws.projectDir('P'), '.ai', 'trash', 'invalid-abc'));
  assert.equal((await archive.list('P')).length, 1);
  await projects.archive('P');
  const [projectEntry] = await archive.list();
  await projects.create({ name: 'P' });
  await assert.rejects(archive.restore(projectEntry!.key));
}));

test('a project is not restored onto a repository another project took while it was archived', () => withTmpWorkspace(async ws => {
  const { projects, archive } = services(ws);
  const body = path.join(ws.root, 'external'); await fs.mkdir(body);
  await projects.create({ name: 'P', body });
  await projects.archive('P');
  const [entry] = await archive.list();
  await projects.create({ name: 'Q', body });
  await assert.rejects(archive.restore(entry!.key), { detail: 'body_shared' });
  assert.deepEqual([(await projects.list()).map(project => project.id), (await archive.list()).length], [['Q'], 1]);
}));

test('a direct task restores its ledger even after the main folder moved, since nothing is checked out', () => withTmpWorkspace(async ws => {
  const { projects, tasks, archive } = services(ws);
  const body = path.join(ws.root, 'external'); await fs.mkdir(body);
  await projects.create({ name: 'P', body });
  const task = await tasks.create('P', { title: 'direct', workspace: 'direct' });
  await tasks.archive('P', task.id);
  const [entry] = await archive.list('P');
  await fs.rename(body, `${body}-moved`);
  await archive.restore(entry!.key, 'P');
  assert.deepEqual([(await tasks.list('P')).map(item => item.id), (await archive.list('P')).length], [[task.id], 0]);
}));

test('project restore reuses an empty leftover ledger folder but refuses one with data', () => withTmpWorkspace(async ws => {
  const { projects, archive } = services(ws);
  await projects.create({ name: 'P' });
  await projects.archive('P');
  const [entry] = await archive.list();
  assert.equal(entry!.body, undefined);
  await fs.mkdir(ws.projectDir('P'));
  await fs.writeFile(path.join(ws.projectDir('P'), 'keep.txt'), 'data\n');
  await assert.rejects(archive.restore(entry!.key));
  assert.equal(await fs.readFile(path.join(ws.projectDir('P'), 'keep.txt'), 'utf8'), 'data\n');
  await fs.rm(path.join(ws.projectDir('P'), 'keep.txt'));
  await archive.restore(entry!.key);
  assert.equal((await projects.get('P')).name, 'P');
  assert.deepEqual(await archive.list(), []);
}));

test('restore refuses archived chat files or attachments that are links to outside files', () => withTmpWorkspace(async (ws, dir) => {
  const { projects, tasks, archive } = services(ws);
  await projects.create({ name: 'P' });
  const outside = path.join(dir, 'outside.jsonl');
  await fs.writeFile(outside, 'outside original\n');
  for (const member of ['chat', 'attachment'] as const) {
    const task = await tasks.create('P', { title: member, workspace: 'direct' });
    await tasks.archive('P', task.id);
    const entry = (await archive.list('P')).find(item => item.task === task.id)!;
    const trash = path.join(ws.projectDir('P'), '.ai', 'trash', entry.key);
    if (member === 'chat') await fs.symlink(outside, path.join(trash, `${task.id}.jsonl`));
    else { await fs.mkdir(path.join(trash, 'attachments')); await fs.symlink(outside, path.join(trash, 'attachments', 'image.png')); }
    await assert.rejects(archive.restore(entry.key, 'P'), { detail: 'archive_unsafe_path' });
    await assert.rejects(fs.access(ws.taskFile('P', task.id)));
    assert.equal((await archive.list('P')).some(item => item.key === entry.key), true);
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside original\n');
  // The same check covers a whole archived project's ledger.
  await fs.rm(path.join(ws.projectDir('P'), '.ai', 'trash'), { recursive: true, force: true });
  await projects.archive('P');
  const [projectEntry] = await archive.list();
  const link = path.join(ws.projectsDir, '.trash', projectEntry!.key, '.ai', 'notes.md');
  await fs.symlink(outside, link);
  await assert.rejects(archive.restore(projectEntry!.key), { detail: 'archive_unsafe_path' });
  await assert.rejects(projects.get('P'));
  await fs.rm(link);
  await archive.restore(projectEntry!.key);
  assert.equal((await projects.get('P')).name, 'P');
}));

test('recovery ignores incomplete staging names and refuses path escape', () => withTmpWorkspace(async ws => {
  const store = new RecoveryStore(ws);
  const root = path.join(ws.internalDir, 'recovery', 'P', '20260101-001');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'partial.tmp'));
  assert.deepEqual(await store.snapshots('P', '20260101-001'), []);
  await assert.rejects(store.snapshots('../outside', '20260101-001'));
}));

test('recovery restores internal relative and absolute symlinks even when the temp folder path is an alias', () => withTmpWorkspace(async ws => {
  // On macOS the temp folder `/var/…` is really `/private/var/…`: links must be checked against the same spelling.
  const destination = ws.worktreeDir('P', '20260101-001');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'target.txt'), 'kept\n');
  await fs.symlink('target.txt', path.join(destination, 'link'));
  await fs.symlink(path.join(destination, 'target.txt'), path.join(destination, 'absolute'));
  const store = new RecoveryStore(ws);
  await store.preserve('P', '20260101-001', destination);
  await fs.mkdir(destination);
  await store.restoreFreshCheckout('P', '20260101-001', destination);
  assert.equal(await fs.readlink(path.join(destination, 'link')), 'target.txt');
  assert.equal(await fs.readFile(path.join(destination, 'link'), 'utf8'), 'kept\n');
  assert.equal(await fs.readFile(path.join(destination, 'absolute'), 'utf8'), 'kept\n');
}));

test('restored recovery bytes never overlay a later archive after a successful merge', () => withTmpWorkspace(async ws => {
  const { projects, tasks, worktree, archive } = services(ws);
  await projects.create({ name: 'P' });
  const task = await tasks.create('P', { title: 'archive generations' });
  const copy = await worktree.prepare('P', task.id);
  await fs.writeFile(path.join(copy, 'value.txt'), 'old recovery A');
  await worktree.abandon('P', task.id);
  await tasks.archive('P', task.id);
  const [first] = await archive.list('P'); assert.ok(first);
  await archive.restore(first.key, 'P');
  await fs.writeFile(path.join(copy, 'value.txt'), 'merged B');
  await fs.writeFile(path.join(copy, 'newer.txt'), 'new path B');
  assert.equal((await worktree.merge('P', task.id)).merged, true);
  await tasks.archive('P', task.id);
  const [second] = await archive.list('P'); assert.ok(second);
  await archive.restore(second.key, 'P');
  const fresh = await worktree.prepare('P', task.id);
  assert.equal(await fs.readFile(path.join(fresh, 'value.txt'), 'utf8'), 'merged B');
  assert.equal(await fs.readFile(path.join(fresh, 'newer.txt'), 'utf8'), 'new path B');
  const recovery = path.join(ws.internalDir, 'recovery');
  const savedFiles = (await fs.readdir(recovery, { recursive: true })).filter(file => file.endsWith('value.txt'));
  const retained = await Promise.all(savedFiles.map(file => fs.readFile(path.join(recovery, file), 'utf8')));
  assert.ok(retained.includes('old recovery A'));
}));

test('archive preview reports initialized submodules as unavailable instead of promising recovery', () => withTmpWorkspace(async (ws, tmp) => {
  const { projects, tasks, worktree, archive } = services(ws);
  await projects.create({ name: 'P' });
  const source = path.join(tmp, 'module-source');
  await fs.mkdir(source);
  await gitOk(source, ['init', '-q']);
  await fs.writeFile(path.join(source, 'module.txt'), 'module\n');
  await commitAll(source, 'module');
  const repo = ws.projectDir('P');
  await gitOk(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'lib']);
  await commitAll(repo, 'submodule');
  const task = await tasks.create('P', { title: 'Unpreservable submodule' });
  const dir = await worktree.prepare('P', task.id);
  assert.deepEqual((await archive.preview('P', task.id)).unavailable, []);
  await gitOk(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init']);
  const preview = await archive.preview('P', task.id);
  assert.deepEqual(preview.unavailable, ['lib']);
  assert.ok(!preview.preserved.includes('lib/.git'));
  assert.deepEqual((await archive.preview('P')).unavailable, [`${task.id}/lib`]);
}));
