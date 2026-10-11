import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Workspace } from './workspace.ts';
import { ProjectLedger } from './projects.ts';
import { TaskLedger } from './tasks.ts';
import { BackupService } from './backup.ts';
import { WorktreeService } from '../git/worktree.ts';
import { gitOk } from '../git/git.ts';

for (const external of [false, true]) test(`private backup restores real dirty worktree (external=${external})`, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'care-backup-'));
  try {
    const ws = new Workspace(path.join(temporary, 'source')); await ws.init();
    const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
    const body = path.join(temporary, 'code'); if (external) await fs.mkdir(body);
    await projects.create({ name: 'P', ...(external ? { body } : {}) });
    const task = await tasks.create('P', { title: '備份' });
    const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
    const workdir = await worktree.prepare('P', task.id);
    await fs.writeFile(path.join(workdir, 'dirty.txt'), 'uncommitted\n');
    await fs.mkdir(ws.attachmentsDir('P', task.id), { recursive: true });
    await fs.writeFile(path.join(ws.attachmentsDir('P', task.id), 'image.png'), 'attachment');
    await fs.writeFile(ws.chatFile('P', task.id, 'jsonl'), '{"prompt":"private prompt"}\n');
    await fs.writeFile(path.join(ws.internalDir, 'credentials.sqlite'), 'credential secret');
    const backup = new BackupService(ws, path.join(temporary, 'private'));
    const snapshot = await backup.create(true);
    assert.equal((await fs.stat(path.join(temporary, 'private', snapshot.id))).mode & 0o777, 0o700);
    await assert.rejects(fs.access(path.join(temporary, 'private', snapshot.id, 'workspace', '.yumeewade', 'credentials.sqlite')));
    const restored = await backup.restore(snapshot.id, path.join(temporary, 'restored'));
    const fresh = new Workspace(restored.root); const freshProjects = new ProjectLedger(fresh); const freshTasks = new TaskLedger(fresh);
    const record = await freshTasks.get('P', task.id);
    assert.ok(record.workdir.startsWith(restored.root));
    assert.equal(await fs.readFile(path.join(record.workdir, 'dirty.txt'), 'utf8'), 'uncommitted\n');
    assert.equal(await fs.readFile(fresh.chatFile('P', task.id, 'jsonl'), 'utf8'), '{"prompt":"private prompt"}\n');
    assert.equal(await fs.readFile(path.join(fresh.attachmentsDir('P', task.id), 'image.png'), 'utf8'), 'attachment');
    const repo = freshProjects.bodyPath(await freshProjects.get('P'));
    if (external) assert.ok(repo.startsWith(path.join(restored.root, 'External')));
    assert.equal((await gitOk(record.workdir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(), path.join(repo, '.git'));
    const service = new WorktreeService({ ws: fresh, projects: freshProjects, tasks: freshTasks, diffBytes: 100_000 });
    assert.equal(await service.prepare('P', task.id), record.workdir);
    assert.match((await service.diff('P', task.id)).diff, /uncommitted/);
    await assert.rejects(backup.restore(snapshot.id, restored.root), { detail: 'care_destination_exists' });
    if (external) { const partial = await backup.create(false); assert.equal(partial.complete, false); await assert.rejects(backup.restore(partial.id, path.join(temporary, 'partial'))); }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('backup rejects escaping symlinks and restore rejects altered snapshots', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'care-safety-'));
  try {
    const ws = new Workspace(path.join(temporary, 'source')); await ws.init();
    const backup = new BackupService(ws, path.join(temporary, 'private'));
    await fs.writeFile(path.join(temporary, 'secret'), 'secret');
    await fs.symlink(path.join(temporary, 'secret'), path.join(ws.root, 'escape'));
    await assert.rejects(backup.create(true));
    await fs.unlink(path.join(ws.root, 'escape'));
    const snapshot = await backup.create(true);
    await fs.writeFile(path.join(temporary, 'private', snapshot.id, 'workspace', 'roles.yaml'), 'changed');
    await assert.rejects(backup.restore(snapshot.id, path.join(temporary, 'destination')));
    await assert.rejects(fs.access(path.join(temporary, 'destination')));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

for (const external of [false, true]) test(`restore isolates main and linked worktree-specific roots (external=${external})`, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'care-worktree-config-'));
  try {
    const ws = new Workspace(path.join(temporary, 'source')); await ws.init();
    const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
    const body = path.join(temporary, 'code'); if (external) await fs.mkdir(body);
    await projects.create({ name: 'P', ...(external ? { body } : {}) });
    const task = await tasks.create('P', { title: '隔離' });
    const service = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
    const workdir = await service.prepare('P', task.id);
    const repo = projects.bodyPath(await projects.get('P'));
    await gitOk(repo, ['config', '--local', 'extensions.worktreeConfig', 'true']);
    await gitOk(repo, ['config', '--local', 'core.worktree', repo]);
    await gitOk(repo, ['config', '--worktree', 'core.worktree', repo]);
    await gitOk(workdir, ['config', '--worktree', 'core.worktree', workdir]);
    await fs.writeFile(path.join(workdir, 'dirty.txt'), 'private dirty worktree\n');
    const backup = new BackupService(ws, path.join(temporary, 'private'));
    const snapshot = await backup.create(true);
    const restored = await backup.restore(snapshot.id, path.join(temporary, 'restored'));
    const fresh = new Workspace(restored.root); const freshProjects = new ProjectLedger(fresh); const freshTasks = new TaskLedger(fresh);
    const restoredRepo = freshProjects.bodyPath(await freshProjects.get('P'));
    const restoredWorkdir = (await freshTasks.get('P', task.id)).workdir;
    for (const root of [restoredRepo, restoredWorkdir]) {
      assert.equal(await fs.realpath((await gitOk(root, ['rev-parse', '--show-toplevel'])).trim()), await fs.realpath(root));
      assert.equal((await gitOk(root, ['config', '--worktree', '--get', 'core.worktree'])).trim(), root);
    }
    assert.equal((await gitOk(restoredRepo, ['config', '--local', '--get', 'core.worktree'])).trim(), restoredRepo);
    assert.equal((await gitOk(repo, ['config', '--worktree', '--get', 'core.worktree'])).trim(), repo);
    assert.equal((await gitOk(workdir, ['config', '--worktree', '--get', 'core.worktree'])).trim(), workdir);
    await fs.writeFile(path.join(restoredWorkdir, 'restored-only.txt'), 'restored');
    await gitOk(restoredWorkdir, ['add', 'restored-only.txt']);
    assert.match(await gitOk(restoredWorkdir, ['diff', '--cached', '--name-only']), /restored-only\.txt/);
    assert.doesNotMatch(await gitOk(workdir, ['status', '--porcelain']), /restored-only\.txt/);
    assert.equal((await fs.stat(path.join(restoredRepo, '.git', 'config.worktree'))).mode & 0o777, 0o600);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

for (const symlink of [false, true]) test(`restore keeps existing External namespace separate (symlink=${symlink})`, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'care-external-collision-'));
  try {
    const ws = new Workspace(path.join(temporary, 'source')); await ws.init();
    const projects = new ProjectLedger(ws); const tasks = new TaskLedger(ws);
    const body = path.join(temporary, 'code'); await fs.mkdir(body);
    await projects.create({ name: 'P', body });
    const task = await tasks.create('P', { title: '名稱衝突' });
    const service = new WorktreeService({ ws, projects, tasks, diffBytes: 100_000 });
    const workdir = await service.prepare('P', task.id);
    const occupied = path.join(ws.root, symlink ? 'existing' : 'External');
    await fs.mkdir(path.join(occupied, '0'), { recursive: true });
    await fs.writeFile(path.join(occupied, '0', 'workspace-only.txt'), 'keep workspace');
    if (symlink) await fs.symlink('existing', path.join(ws.root, 'External'));
    await fs.mkdir(path.join(ws.root, 'External-1'));
    await fs.writeFile(path.join(body, 'repository-only.txt'), 'keep repository');
    await fs.writeFile(path.join(workdir, 'dirty.txt'), 'keep linked worktree');
    const backup = new BackupService(ws, path.join(temporary, 'private'));
    const snapshot = await backup.create(true);
    const restored = await backup.restore(snapshot.id, path.join(temporary, 'restored'));
    const fresh = new Workspace(restored.root); const freshProjects = new ProjectLedger(fresh); const freshTasks = new TaskLedger(fresh);
    const repo = freshProjects.bodyPath(await freshProjects.get('P'));
    const linked = (await freshTasks.get('P', task.id)).workdir;
    assert.equal(repo, path.join(restored.root, 'External-2', '0'));
    assert.equal(await fs.readFile(path.join(restored.root, 'External', '0', 'workspace-only.txt'), 'utf8'), 'keep workspace');
    assert.equal(await fs.readFile(path.join(repo, 'repository-only.txt'), 'utf8'), 'keep repository');
    await assert.rejects(fs.access(path.join(repo, 'workspace-only.txt')));
    await assert.rejects(fs.access(path.join(restored.root, 'External', '0', 'repository-only.txt')));
    assert.equal(await fs.readFile(path.join(linked, 'dirty.txt'), 'utf8'), 'keep linked worktree');
    for (const root of [repo, linked]) assert.equal(await fs.realpath((await gitOk(root, ['rev-parse', '--show-toplevel'])).trim()), await fs.realpath(root));
    assert.equal((await fs.stat(path.join(restored.root, 'External-2'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(repo)).mode & 0o777, 0o700);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
