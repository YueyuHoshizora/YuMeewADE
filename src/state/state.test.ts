import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { App } from '../server/app.ts';
import { MockCliProvider } from '../cli/mock.ts';
import { parseConfig } from '../shared/config.ts';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'state-cache-'));
  const app = new App(parseConfig(`workspace:\n  root: ${JSON.stringify(root)}\n`, path.join(root, 'config.yaml')), {
    providers: { mock: new MockCliProvider(5) }, home: path.join(root, 'home'),
  });
  await app.init();
  await app.projects.create({ name: 'Project' });
  const task = await app.tasks.create('Project', { title: 'Before', workspace: 'direct' });
  return { app, task, async close() { app.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('cached ledger snapshot is reused; changed and TTL refresh it while running/unread stay fresh', async (t) => {
  const f = await fixture();
  try {
    // Isolate explicit invalidation and TTL from platform watch delivery.
    f.app.close();
    const first = await f.app.state();
    const second = await f.app.state();
    assert.equal(first.projects, second.projects);
    const run = { project: 'Project', task: f.task.id, ai: 'mock', request: 'request', startedAt: 'now' };
    t.mock.method(f.app.runner, 'running', () => [run]);
    t.mock.method(f.app.runner, 'unread', () => [{ project: 'Project', task: f.task.id }]);
    const fresh = await f.app.state();
    assert.equal(fresh.projects, first.projects);
    assert.deepEqual(fresh.running, [run]);
    assert.deepEqual(fresh.unread, [{ project: 'Project', task: f.task.id }]);
    await f.app.tasks.update('Project', f.task.id, { title: 'After' });
    assert.equal((await f.app.state()).projects[0]?.tasks[0]?.title, 'Before');
    f.app.changed();
    assert.equal((await f.app.state()).projects[0]?.tasks[0]?.title, 'After');
    await f.app.tasks.update('Project', f.task.id, { title: 'Expired' });
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 6000);
    assert.equal((await f.app.state()).projects[0]?.tasks[0]?.title, 'Expired');
  } finally { await f.close(); }
});

test('external task edits invalidate the state cache', async () => {
  const f = await fixture();
  try {
    await f.app.state();
    await f.app.tasks.update('Project', f.task.id, { title: 'External' });
    // fs.watch is a real platform event; bounded polling awaits the resulting state.
    const deadline = Date.now() + 3000;
    while ((await f.app.state()).projects[0]?.tasks[0]?.title !== 'External') {
      assert.ok(Date.now() < deadline, 'external state invalidation timed out');
      await delay(20);
    }
  } finally { await f.close(); }
});

test('projects named like Object members keep their own child order', async () => {
  const f = await fixture();
  try {
    for (const name of ['constructor', '__proto__']) {
      await f.app.projects.create({ name });
      for (const child of [`${name}-a`, `${name}-b`]) await f.app.projects.create({ name: child, parent: name });
      await f.app.order.setOrder(name, [`${name}-b`, `${name}-a`]);
      assert.deepEqual((await f.app.order.get()).order[name], [`${name}-b`, `${name}-a`], 'saved order survives a reread');
    }
    f.app.changed();
    // Over HTTP the snapshot is parsed again, as the sidebar sees it.
    const order = JSON.parse(JSON.stringify((await f.app.state()).order)) as Record<string, string[]>;
    assert.ok(Object.hasOwn(order, 'constructor') && Object.hasOwn(order, '__proto__'));
    assert.deepEqual([order['constructor'], order['__proto__']], [['constructor-b', 'constructor-a'], ['__proto__-b', '__proto__-a']]);
  } finally { await f.close(); }
});

test('unparseable ledger files are reported instead of silently disappearing, and clear once fixed', async () => {
  const f = await fixture();
  try {
    f.app.close();
    await f.app.projects.create({ name: 'Broken' });
    const projectFile = f.app.ws.projectFile('Broken'); const taskFile = path.join(f.app.ws.tasksDir('Project'), `${f.task.id}.md`);
    const [projectText, taskText, rolesText] = await Promise.all([fs.readFile(projectFile, 'utf8'), fs.readFile(taskFile, 'utf8'), fs.readFile(f.app.ws.rolesFile, 'utf8')]);
    await fs.writeFile(projectFile, '---\nname: [unclosed\n---\n');
    await fs.writeFile(taskFile, '---\nstate: [unclosed\n---\n');
    await fs.writeFile(f.app.ws.rolesFile, 'roles:\n  - name: [unclosed\n');
    // Valid JSON of the wrong shape: the sidebar order falls back to the default instead of failing every page.
    await fs.writeFile(f.app.order.file, JSON.stringify({ order: { '': 'Project' }, pins: [] }));
    // Not ledgers, so never reported: an empty project folder and a file whose name is not a task id.
    await fs.mkdir(path.join(f.app.ws.projectsDir, 'Empty'));
    await fs.writeFile(path.join(f.app.ws.tasksDir('Project'), 'my notes.md'), 'scratch');
    f.app.changed();
    const broken = await f.app.state();
    assert.deepEqual(broken.projects.map(project => [project.id, project.tasks.length]), [['Project', 0]]);
    assert.deepEqual(broken.unreadable, [path.join('.yumeewade', 'order.json'), path.join('Projects', 'Broken', 'PROJECT.md'), path.join('Projects', 'Project', '.ai', 'tasks', `${f.task.id}.md`), 'roles.yaml']);
    assert.deepEqual(Object.keys(broken.roles.roles), []);
    await Promise.all([fs.writeFile(projectFile, projectText), fs.writeFile(taskFile, taskText), fs.writeFile(f.app.ws.rolesFile, rolesText), fs.rm(f.app.order.file)]);
    f.app.changed();
    const fixed = await f.app.state();
    assert.deepEqual(fixed.unreadable, []);
    assert.deepEqual(fixed.projects.map(project => [project.id, project.tasks.length]), [['Broken', 0], ['Project', 1]]);
  } finally { await f.close(); }
});

test('concurrent rebuilds share a snapshot and invalidation during a build cannot cache stale data', async () => {
  const f = await fixture();
  try {
    f.app.close();
    const original = f.app.projects.list.bind(f.app.projects);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let block = true;
    f.app.projects.list = async () => {
      const projects = await original();
      if (block) {
        entered.resolve();
        await release.promise;
      }
      return projects;
    };
    const a = f.app.state();
    const b = f.app.state();
    await entered.promise;
    await f.app.projects.update('Project', { status: '完成' });
    f.app.changed();
    block = false;
    const current = await f.app.state();
    assert.equal(current.projects[0]?.status, '完成');
    release.resolve();
    const [oldA, oldB] = await Promise.all([a, b]);
    assert.equal(oldA.projects, oldB.projects);
    assert.notEqual(oldA.projects[0]?.status, '完成');
    assert.equal((await f.app.state()).projects, current.projects);
  } finally { await f.close(); }
});
