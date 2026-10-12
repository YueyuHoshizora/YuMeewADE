import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startTestServer } from '../testing/server.ts';
import type { AppState, Project, ProjectTrustView, Settings, Task } from '../shared/types.ts';
import { MockCliProvider } from '../cli/mock.ts';
import { gitOk } from '../git/git.ts';

async function setup() {
  const server = await startTestServer('', { providers: { mock: new MockCliProvider(5) } });
  const project = (await server.api('POST', '/api/project/new', { name: 'Demo' })).json as Project;
  const task = (await server.api('POST', '/api/task/new', { project: project.id, title: 'First', phase: '計畫', steps: ['Implement'], cli: 'mock' })).json as Task;
  return { server, project, task };
}

test('project-scope files use the external main folder and retain file and trust boundaries', async () => {
  const s = await startTestServer();
  try {
    const root = path.join(s.dir, 'main-folder');
    await fs.mkdir(root);
    await gitOk(root, ['init', '-q']);
    const p = (await s.api('POST', '/api/project/new', { name: 'External', body: root })).json as Project;
    await fs.writeFile(path.join(root, 'source.txt'), 'main folder\n');
    await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(300 * 1024));
    await fs.writeFile(path.join(root, '.env'), 'private');
    await fs.writeFile(path.join(root, '.npmrc'), 'private');
    await fs.writeFile(path.join(s.dir, 'outside.txt'), 'outside');
    await fs.symlink(path.join(s.dir, 'outside.txt'), path.join(root, 'escape.txt'));
    await gitOk(root, ['add', '.env', '.npmrc', 'source.txt', 'large.txt', 'escape.txt']);
    await Promise.all(Array.from({ length: 55 }, (_, n) => fs.writeFile(path.join(root, `entry-${n}.txt`), 'entry')));
    for (const taskQuery of ['', '&task=']) {
      const suffix = `?project=${p.id}${taskQuery}`;
      const list = await s.api('GET', `/api/task/files${suffix}`);
      assert.equal(list.status, 200);
      const files = list.json as { files: string[]; total: number };
      assert.equal(files.files.length, 50);
      assert.equal(files.total, 58);
      assert.ok(files.files.every(file => file !== '.env' && file !== '.npmrc'));
      const found = await s.api('GET', `/api/task/files${suffix}&q=SOURCE`);
      assert.deepEqual(found.json, { files: ['source.txt'], total: 1 });
      const read = await s.api('GET', `/api/task/file${suffix}&path=source.txt`);
      assert.equal(read.status, 200);
      assert.ok(read.json && typeof read.json === 'object' && 'text' in read.json);
      assert.equal(read.json.text, 'main folder\n');
      const large = await s.api('GET', `/api/task/file${suffix}&path=large.txt`);
      assert.ok(large.json && typeof large.json === 'object' && 'truncated' in large.json && 'text' in large.json && typeof large.json.text === 'string');
      assert.equal(large.json.truncated, true);
      assert.equal(large.json.text.length, 256 * 1024);
      for (const file of ['.env', '.npmrc', '../outside.txt', 'escape.txt']) {
        const denied = await s.api('GET', `/api/task/file${suffix}&path=${encodeURIComponent(file)}`);
        assert.equal(denied.status, 404);
        assert.ok(denied.json && typeof denied.json === 'object' && 'detail' in denied.json);
        assert.equal(denied.json.detail, 'file_missing');
      }
    }
    // The browser passes no task for scope recovery and document reads.
    assert.equal((await s.api('GET', `/api/editor/scope?project=${p.id}`)).status, 200);
    const document = await s.api('GET', `/api/editor/file?project=${p.id}&path=source.txt`);
    assert.equal(document.status, 200);
    assert.ok(document.json && typeof document.json === 'object' && 'text' in document.json);
    assert.equal(document.json.text, 'main folder\n');
    assert.equal((await s.api('GET', `/api/task/files?project=${p.id}&task=${'x'.repeat(121)}`)).status, 400);
    const trust = await s.app.trust.view(p.id);
    await s.app.trust.update(p.id, { state: 'restricted', overrides: {}, revision: trust.revision, confirmed: true });
    for (const route of [`/api/task/files?project=${p.id}`, `/api/task/file?project=${p.id}&task=&path=source.txt`]) {
      const denied = await s.api('GET', route);
      assert.equal(denied.status, 403);
      assert.ok(denied.json && typeof denied.json === 'object' && 'detail' in denied.json);
      assert.equal(denied.json.detail, 'project_restricted');
    }
  } finally { await s.close(); }
});

test('a differently cased alias of a project name is refused like a missing project, so it cannot slip past name-keyed locks', async () => {
  const s = await startTestServer();
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Alias' })).json as { id: string };
    const insensitive = await fs.stat(path.join(s.app.ws.projectsDir, 'alias')).then(() => true, () => false);
    const trust = await s.app.trust.view(p.id);
    await s.app.trust.update(p.id, { state: 'restricted', overrides: {}, revision: trust.revision, confirmed: true });
    assert.equal((await s.api('GET', '/api/git/status?project=Alias')).status, 403);
    const alias = await s.api('GET', '/api/git/status?project=alias');
    // On a case-sensitive file system `alias` simply does not exist.
    assert.equal(alias.status, 404, insensitive ? 'alias of a restricted project' : 'missing project');
    assert.equal((await s.api('POST', '/api/project/update', { project: 'alias', description: 'x' })).status, 404);
    assert.equal((await s.app.projects.get(p.id)).description, '');
  } finally { await s.close(); }
});

test('state, completion approval and step hash continuation', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  const view = async () => ((await s.api('GET', '/api/state')).json as AppState).projects[0]!;
  try {
    assert.equal((await view()).tasks[0]!.confirm, false);
    assert.equal((await s.api('POST', '/api/task/step', { ...ids, index: 0, done: true })).status, 400);
    assert.equal((await s.api('POST', '/api/task/step', { ...ids, index: 0, text: 'Other', done: true })).status, 409);
    assert.equal((await s.api('POST', '/api/task/step', { ...ids, index: 0, text: 'Implement', done: true })).status, 200);
    assert.equal((await view()).tasks[0]!.confirm, true);
    await s.api('POST', '/api/task/completion', { ...ids, action: 'continue' });
    assert.equal((await view()).tasks[0]!.confirm, false);
    await s.api('POST', '/api/task/step', { ...ids, add: 'Review' });
    await s.api('POST', '/api/task/step', { ...ids, index: 1, text: 'Review', done: true });
    assert.equal((await view()).tasks[0]!.confirm, true);
    // External ledger completion requires approval, unlike the human update route.
    await s.app.tasks.update(p.id, t.id, { state: '完成' });
    assert.equal((await view()).tasks[0]!.confirm, true);
    await s.api('POST', '/api/task/completion', { ...ids, action: 'approve' });
    assert.equal((await view()).tasks[0]!.confirm, false);
    await s.api('POST', '/api/task/completion', { ...ids, action: 'continue' });
    assert.equal((await view()).tasks[0]!.state, '進行中');
    assert.equal(await s.app.completion.isApproved(p.id, t.id), false);
    await s.api('POST', '/api/task/update', { ...ids, patch: { state: '完成' } });
    assert.equal(await s.app.completion.isApproved(p.id, t.id), true);
    await s.api('POST', '/api/task/update', { ...ids, patch: { state: '暫停' } });
    assert.equal(await s.app.completion.isApproved(p.id, t.id), false);
    assert.equal((await s.api('POST', '/api/task/step', { ...ids, index: 0, text: 'Implement', done: 'yes' })).status, 400);
    assert.equal((await s.api('POST', '/api/task/completion', { ...ids, action: 'invalid' })).status, 400);
    assert.ok((await s.app.oplog.recent(200)).some((entry) => entry.action === 'task.approve'));
  } finally { await s.close(); }
});

test('steps can be renamed and reordered only with the text shown and one change per request', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  const step = (body: Record<string, unknown>) => s.api('POST', '/api/task/step', { ...ids, ...body });
  const texts = async () => (await s.app.tasks.get(p.id, t.id)).steps.map(item => item.text);
  try {
    await step({ add: 'Review' });
    assert.equal((await step({ index: 0, text: 'Implement', rename: 'Build', move: 1 })).status, 400);
    assert.equal((await step({ index: 0, text: 'Implement', done: true, rename: 'Build' })).status, 400);
    assert.equal((await step({ add: 'X', move: 1 })).status, 400);
    assert.equal((await step({ index: 0, text: 'Implement', move: 2 })).status, 400);
    assert.equal((await step({ index: 0, text: 'Implement', move: -1 })).status, 400);
    assert.equal((await step({ index: 0, text: 'Stale', rename: 'Build' })).status, 409);
    assert.equal((await step({ index: 0, text: 'Implement', rename: '  ' })).status, 400);
    assert.equal((await step({ index: 0, text: 'Implement', rename: 'Build $& it' })).status, 200);
    assert.equal((await step({ index: 1, text: 'Review', move: -1 })).status, 200);
    assert.deepEqual(await texts(), ['Review', 'Build $& it']);
    // Adding has the same per-step bound as renaming and templates.
    assert.equal((await step({ add: 'z'.repeat(2000) })).status, 200);
    assert.equal((await step({ add: 'z'.repeat(2001) })).status, 400);
  } finally { await s.close(); }
});

test('a draft image whose file was removed outside the app is not found rather than an internal error', async () => {
  const { server: s, project: p, task: t } = await setup();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const res = await fetch(`${s.base}/api/upload?${new URLSearchParams({ project: p.id, scope: t.id, name: 'a.png' })}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    const image = await res.json() as { id: string };
    const url = `/api/chat/draft-image?${new URLSearchParams({ project: p.id, scope: t.id, id: image.id })}`;
    assert.equal((await s.api('GET', url)).status, 200);
    await fs.rm(path.join(s.app.ws.uploadsDir(p.id), image.id));
    assert.equal((await s.api('GET', url)).status, 404);
  } finally { await s.close(); }
});

test('a moved main folder is flagged in the state and the project can be pointed at its new location', async () => {
  const s = await startTestServer('', { providers: { mock: new MockCliProvider({ chunkMs: 50, text: () => 'x'.repeat(40) }) } });
  try {
    const body = path.join(s.dir, 'code'); await fs.mkdir(body); await gitOk(body, ['init', '-q']);
    const project = (await s.api('POST', '/api/project/new', { name: 'Ext', body })).json as Project;
    const flagged = async () => ((await s.api('GET', '/api/state')).json as AppState).projects.find(p => p.id === project.id)!.bodyMissing;
    assert.equal(await flagged(), false);
    const moved = path.join(s.dir, 'moved'); await fs.rename(body, moved);
    assert.equal(await flagged(), true);
    // A mistyped location is reported as such, not as a malformed field.
    for (const wrong of [body, 'relative/path']) {
      const refused = await s.api('POST', '/api/project/update', { project: project.id, patch: { body: wrong } });
      assert.deepEqual([refused.status, (refused.json as { detail: string }).detail], [400, 'body_not_folder']);
    }
    assert.equal((await s.api('POST', '/api/project/update', { project: project.id, patch: { body: moved } })).status, 200);
    assert.equal(await flagged(), false);
    const view = (await s.api('GET', `/api/project/trust?project=${project.id}`)).json as ProjectTrustView;
    assert.equal(view.root, await fs.realpath(moved));
    // Work holding the folder must stop before the project points elsewhere.
    const task = (await s.api('POST', '/api/task/new', { project: project.id, title: 'T', cli: 'mock', workspace: 'direct' })).json as Task;
    await s.api('POST', '/api/project/trust', { project: project.id, state: 'trusted', overrides: {}, revision: view.revision, confirmed: true });
    assert.equal((await s.api('POST', '/api/chat/send', { project: project.id, task: task.id, text: 'go', ai: 'mock' })).status, 200);
    const refused = await s.api('POST', '/api/project/update', { project: project.id, patch: { body } });
    assert.equal(refused.status, 409);
    await s.api('POST', '/api/chat/stop', { project: project.id, task: task.id });
  } finally { await s.close(); }
});

test('model and effort are validated the same way before any CLI starts', async () => {
  const { server: s, project: p, task: t } = await setup();
  try {
    const base = { project: p.id, task: t.id, ai: 'mock', text: 'x' };
    for (const extra of [{ model: '--dangerous' }, { model: 'a\nb' }, { model: 'm'.repeat(201) }, { effort: 'bogus' }, { model: 42 }]) {
      assert.equal((await s.api('POST', '/api/chat/send', { ...base, ...extra })).status, 400, JSON.stringify(extra));
      assert.equal((await s.api('POST', '/api/review/run', { ...base, ...extra })).status, 400, JSON.stringify(extra));
    }
    assert.equal((await s.api('POST', '/api/chat/send', { ...base, model: '', effort: '' })).status, 200);
  } finally { await s.close(); }
});

test('AI names that are Object.prototype properties are unsupported, not internal errors', async () => {
  const { server: s, project: p, task: t } = await setup();
  try {
    for (const ai of ['toString', 'constructor', '__proto__']) {
      const response = await s.api('GET', `/api/task/handoff?project=${p.id}&task=${t.id}&ai=${ai}`);
      assert.equal(response.status, 400, ai);
    }
  } finally { await s.close(); }
});

test('phase offer, continuation key, legacy fallback, order and pins', async () => {
  const { server: s, project: p, task: t } = await setup();
  const state = async () => (await s.api('GET', '/api/state')).json as AppState;
  try {
    await s.api('POST', '/api/task/update', { project: p.id, task: t.id, patch: { state: '完成' } });
    assert.equal((await state()).projects[0]!.phaseOffer, true);
    assert.equal((await s.api('POST', '/api/phase/continue', { project: p.id, phase: '實作' })).status, 409);
    assert.equal((await state()).projects[0]!.phaseOffer, true);
    await s.api('POST', '/api/phase/continue', { project: p.id, phase: '計畫' });
    assert.equal((await state()).projects[0]!.phaseOffer, false);
    const next = (await s.api('POST', '/api/task/new', { project: p.id, title: 'Next', phase: '計畫' })).json as Task;
    await s.api('POST', '/api/task/update', { project: p.id, task: next.id, patch: { state: '完成' } });
    assert.equal((await state()).projects[0]!.phaseOffer, true);
    assert.equal((await s.api('POST', '/api/phase/next', { project: p.id })).status, 400);
    await s.api('POST', '/api/phase/next', { project: p.id, phase: '計畫' });
    assert.equal((await state()).projects[0]!.currentPhase, '實作');
    assert.equal((await state()).projects[0]!.phaseOffer, false);
    const stale = await s.api('POST', '/api/phase/next', { project: p.id, phase: '計畫' });
    assert.equal(stale.status, 409); assert.equal((stale.json as { detail: string }).detail, 'phase_changed');
    assert.equal((await state()).projects[0]!.currentPhase, '實作');
    await s.api('POST', '/api/task/update', { project: p.id, task: t.id, patch: { phase: '' } });
    await s.api('POST', '/api/task/update', { project: p.id, task: next.id, patch: { phase: '' } });
    assert.equal((await state()).projects[0]!.phaseOffer, true);
    const second = (await s.api('POST', '/api/project/new', { name: 'Other' })).json as Project;
    await s.api('POST', '/api/order', { parent: '', order: [second.id] });
    await s.api('POST', '/api/pin', { project: p.id, pinned: true });
    const result = await state();
    assert.deepEqual(result.order[''], [second.id, p.id]);
    assert.equal(result.projects.find((project) => project.id === p.id)!.pinned, true);
    assert.equal((await s.api('POST', '/api/pin', { project: p.id, pinned: 'true' })).status, 400);
    assert.equal((await s.api('GET', '/api/log?n=bad')).status, 400);
  } finally { await s.close(); }
});

test('editing phases renames tasks along, keeps states, normalizes the current phase and rejects stale or duplicate lists', async () => {
  const { server: s, project: p } = await setup();
  const state = async () => ((await s.api('GET', '/api/state')).json as AppState).projects[0]!;
  try {
    const done = (await s.api('POST', '/api/task/new', { project: p.id, title: 'Plan', phase: '計畫' })).json as Task;
    const later = (await s.api('POST', '/api/task/new', { project: p.id, title: 'Build', phase: '實作' })).json as Task;
    await s.api('POST', '/api/phase/next', { project: p.id, phase: '計畫' });
    const previous = ['計畫', '實作', '檢查', '收尾'];
    // Rename 實作, insert a phase before it, drop 收尾.
    const edited = await s.api('POST', '/api/project/phases', { project: p.id, previous, phases: [{ name: '計畫', from: '計畫' }, { name: '設計' }, { name: '開發', from: '實作' }, { name: '檢查', from: '檢查' }] });
    assert.equal(edited.status, 200);
    const project = await state();
    assert.deepEqual(project.phases, [{ name: '計畫', state: '完成' }, { name: '設計', state: '進行中' }, { name: '開發', state: '未開始' }, { name: '檢查', state: '未開始' }]);
    assert.equal(project.currentPhase, '設計');
    assert.equal(project.tasks.find(task => task.id === later.id)!.phase, '開發');
    assert.equal(project.tasks.find(task => task.id === done.id)!.phase, '計畫');
    const stale = await s.api('POST', '/api/project/phases', { project: p.id, previous, phases: [{ name: 'X' }] });
    assert.equal(stale.status, 409); assert.equal((stale.json as { detail: string }).detail, 'phase_changed');
    const current = project.phases.map(phase => phase.name);
    const duplicate = await s.api('POST', '/api/project/phases', { project: p.id, previous: current, phases: [{ name: '計畫', from: '計畫' }, { name: ' 計畫 ' }] });
    assert.equal(duplicate.status, 400); assert.equal((duplicate.json as { detail: string }).detail, 'phase_duplicate');
    assert.equal((await s.api('POST', '/api/project/phases', { project: p.id, previous: current, phases: [{ name: 'A', from: '不存在' }] })).status, 400);
    // The generic update must not bypass these checks.
    assert.equal((await s.api('POST', '/api/project/update', { project: p.id, patch: { phases: [{ name: '計畫', state: '完成' }, { name: '計畫', state: '進行中' }] } })).status, 400);
    assert.deepEqual((await state()).phases.map(phase => phase.name), current);
  } finally { await s.close(); }
});

test('force archive discards the copy but keeps its work on the task branch', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  try {
    const copy = await s.app.worktree.prepare(p.id, t.id);
    await fs.writeFile(path.join(copy, 'unmerged.txt'), 'keep me');
    const refused = await s.api('POST', '/api/task/archive', { ...ids, force: 'yes' });
    assert.equal(refused.status, 409);
    assert.equal((refused.json as { detail?: string }).detail, 'archive_has_worktree');
    assert.equal((await s.api('POST', '/api/task/archive', { ...ids, force: true })).status, 200);
    assert.equal(await fs.access(copy).then(() => true, () => false), false);
    const repo = await s.app.worktree.bodyPath(p.id);
    assert.equal(await fs.readFile(path.join(repo, 'unmerged.txt'), 'utf8').catch(() => null), null);
    assert.equal((await gitOk(repo, ['show', `${s.app.worktree.branch(t.id)}:unmerged.txt`])), 'keep me');
  } finally { await s.close(); }
});

test('force archive finishes a copy whose git registration is already gone', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  try {
    const copy = await s.app.worktree.prepare(p.id, t.id);
    const repo = await s.app.worktree.bodyPath(p.id);
    await fs.rm(path.join(repo, '.git', 'worktrees'), { recursive: true, force: true });
    assert.equal((await s.api('POST', '/api/task/archive', { ...ids, force: true })).status, 200);
    assert.equal(await fs.access(copy).then(() => true, () => false), false);
  } finally { await s.close(); }
});

test('force archive refuses a copy that was switched off its task branch', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  try {
    const copy = await s.app.worktree.prepare(p.id, t.id);
    const repo = await s.app.worktree.bodyPath(p.id);
    const main = (await gitOk(repo, ['rev-parse', 'HEAD'])).trim();
    await gitOk(copy, ['checkout', '-q', '--detach']);
    await fs.writeFile(path.join(copy, 'stray.txt'), 'x');
    const refused = await s.api('POST', '/api/task/archive', { ...ids, force: true });
    assert.equal(refused.status, 409);
    assert.equal((refused.json as { detail?: string }).detail, 'worktree_wrong_branch');
    assert.equal((await gitOk(repo, ['rev-parse', 'HEAD'])).trim(), main);
    assert.equal(await fs.access(copy).then(() => true, () => false), true);
  } finally { await s.close(); }
});

test('archive copy guards, missing copy clear, memo and read', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  try {
    const copy = await s.app.worktree.prepare(p.id, t.id);
    assert.equal((await s.api('POST', '/api/task/archive', ids)).status, 409);
    assert.equal((await s.api('POST', '/api/project/archive', { project: p.id })).status, 409);
    assert.equal((await s.api('POST', '/api/task/copyclear', ids)).status, 409);
    await fs.rm(copy, { recursive: true, force: true });
    const before = (await s.api('GET', '/api/state')).json as AppState;
    assert.equal(before.projects[0]!.tasks[0]!.copyMissing, true);
    assert.equal((await s.api('POST', '/api/task/copyclear', ids)).status, 200);
    assert.equal((await s.app.tasks.get(p.id, t.id)).workdir, '');
    assert.equal((await s.api('POST', '/api/task/memo', { ...ids, text: 'A note' })).status, 200);
    assert.match((await s.app.tasks.get(p.id, t.id)).memo, /A note/);
    assert.equal((await s.api('POST', '/api/task/read', ids)).status, 200);
    assert.equal((await s.api('POST', '/api/task/archive', ids)).status, 200);
    assert.equal((await s.api('POST', '/api/project/archive', { project: p.id })).status, 200);
    assert.deepEqual(((await s.api('GET', '/api/state')).json as AppState).projects, []);
    assert.equal((await s.api('POST', '/api/open', { path: 'relative' })).status, 400);
  } finally { await s.close(); }
});

test('running archive/merge guards and unread read transition use mock provider', async () => {
  const s = await startTestServer('', { providers: { mock: new MockCliProvider({ chunkMs: 100, text: 'Completed mock response' }) } });
  try {
    const p = (await s.api('POST', '/api/project/new', { name: 'Running' })).json as Project;
    const t = (await s.api('POST', '/api/task/new', { project: p.id, title: 'Work', cli: 'mock', workspace: 'direct' })).json as Task;
    const ids = { project: p.id, task: t.id };
    await s.app.runner.send({ ...ids, ai: 'mock', text: 'Run' });
    assert.equal((await s.api('POST', '/api/task/archive', ids)).status, 409);
    assert.equal((await s.api('POST', '/api/project/archive', { project: p.id })).status, 409);
    assert.equal((await s.api('POST', '/api/task/merge', ids)).status, 409);
    await s.app.runner.whenIdle();
    const state = (await s.api('GET', '/api/state')).json as AppState;
    assert.equal(state.projects[0]!.tasks[0]!.hasChat, true);
    assert.deepEqual(state.unread, [ids]);
    await s.api('POST', '/api/task/read', ids);
    assert.deepEqual(s.app.runner.unread(), []);
  } finally { await s.close(); }
});

test('HTTP gate rejects bad host/origin, malformed JSON and oversized bodies', async () => {
  const s = await startTestServer('limits:\n  bodyBytes: 100\n');
  const raw = (headers: Record<string, string>, chunks: string[]): Promise<number> => {
    const { promise, resolve } = Promise.withResolvers<number>();
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/project/new', method: 'POST', headers }, (res) => {
      res.resume(); resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(-1));
    for (const chunk of chunks) req.write(chunk);
    req.end();
    return promise;
  };
  try {
    assert.equal(await raw({ Host: 'evil.example:80' }, ['{}']), 403);
    assert.equal((await s.api('POST', '/api/project/new', { name: 'A' }, { Origin: 'http://evil.example' })).status, 403);
    // A GET from another site or another loopback port (dev server, embedded preview) is refused; the UI itself is not.
    // `//host/api/state` routes to /api/state too, so it must meet the same gate.
    for (const site of ['cross-site', 'same-site']) for (const target of ['/api/state', '//evil.example/api/state', '//localhost/api/state']) assert.equal((await s.api('GET', target, undefined, { 'Sec-Fetch-Site': site })).status, 403, `${site} ${target}`);
    for (const site of ['same-origin', 'none']) assert.equal((await s.api('GET', '/api/state', undefined, { 'Sec-Fetch-Site': site })).status, 200, site);
    assert.equal((await s.api('POST', '/api/project/new', '{bad')).status, 400);
    assert.equal((await s.api('POST', '/api/project/new', '[1]')).status, 400);
    assert.equal((await s.api('POST', '/api/project/new', { name: 'x'.repeat(200) })).status, 413);
    assert.equal(await raw({ 'Transfer-Encoding': 'chunked' }, ['{"name":"', 'y'.repeat(300), '"}']), 413);
  } finally { await s.close(); }
});

test('account APIs register, activate, refresh and remove existing profiles safely', async () => {
  const s = await startTestServer('');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-account-http-'));
  try {
    assert.equal((await s.api('POST', '/api/accounts/add', { ai: 'codex', name: 'Other', configDir: 'relative' })).status, 400);
    const added = await s.api('POST', '/api/accounts/add', { ai: 'codex', name: 'Other', configDir: dir });
    assert.equal(added.status, 200);
    const account = (added.json as Settings).accounts.codex![0]!;
    assert.equal(account.configDir, dir);
    assert.equal((await s.api('POST', '/api/accounts/add', { ai: 'codex', name: 'Duplicate', configDir: dir })).status, 409);
    assert.equal((await s.api('POST', '/api/settings', { accounts: {} })).status, 400);
    assert.equal((await s.api('POST', '/api/settings', { activeAccounts: { codex: 'unknown' } })).status, 404);
    const activated = await s.api('POST', '/api/settings', { activeAccounts: { codex: account.id } });
    assert.equal(activated.status, 200);
    assert.equal((activated.json as Settings).activeAccounts.codex, account.id);
    assert.equal((await s.api('POST', '/api/accounts/refresh', {})).status, 200);
    const removed = await s.api('POST', '/api/accounts/remove', { ai: 'codex', id: account.id });
    assert.equal(removed.status, 200);
    assert.equal((removed.json as Settings).activeAccounts.codex, 'default');
    assert.ok((await fs.stat(dir)).isDirectory());
    assert.equal((await s.api('POST', '/api/settings', { activeAccounts: { codex: account.id } })).status, 404);
    s.app.refreshUsage = async () => { throw new Error('secret credential raw failure'); };
    const failed = await s.api('POST', '/api/accounts/refresh', {});
    assert.equal(failed.status, 503);
    assert.equal(JSON.stringify(failed.json).includes('secret'), false);
    assert.equal((await s.api('POST', '/api/accounts/add', { ai: 'claude', name: 'Refresh failure is safe', configDir: dir })).status, 200);
  } finally { await s.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('restricted projects block Git reads that can execute repository clean filters', async () => {
  const { server: s, project: p, task: t } = await setup();
  try {
    const root = s.app.ws.projectDir(p.id);
    const marker = path.join(s.app.ws.root, 'filter-marker');
    const filter = path.join(s.app.ws.root, 'filter.ts');
    await fs.writeFile(filter, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'executed\\n'); process.stdin.pipe(process.stdout);`);
    await fs.writeFile(path.join(root, '.gitattributes'), 'source.txt filter=local\n');
    await fs.writeFile(path.join(root, 'source.txt'), 'before\n');
    await gitOk(root, ['config', 'filter.local.clean', `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`]);
    await gitOk(root, ['add', '.gitattributes', 'source.txt']);
    await gitOk(root, ['commit', '-m', 'filter fixture']);
    await fs.writeFile(path.join(root, 'source.txt'), 'after\n');
    await fs.rm(marker, { force: true });
    const update = async (state: 'restricted' | 'trusted') => {
      const view = (await s.api('GET', `/api/project/trust?project=${p.id}`)).json as ProjectTrustView;
      assert.equal((await s.api('POST', '/api/project/trust', { project: p.id, state, overrides: {}, revision: view.revision, confirmed: true })).status, 200);
    };
    await update('restricted');
    for (const route of [`/api/git/status?project=${p.id}`, `/api/git/diff?project=${p.id}&path=source.txt`, `/api/task/preview?project=${p.id}&task=${t.id}`, `/api/task/diff?project=${p.id}&task=${t.id}`, `/api/task/merged?project=${p.id}&task=${t.id}`, `/api/chat/turn-diff?project=${p.id}&task=${t.id}&request=r`]) {
      const response = await s.api('GET', route);
      assert.equal(response.status, 403);
      assert.equal((response.json as { detail: string }).detail, 'project_restricted');
    }
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    assert.equal((await s.api('GET', '/api/state')).status, 200);
    await update('trusted');
    assert.equal((await s.api('GET', `/api/git/diff?project=${p.id}&path=source.txt`)).status, 200);
    assert.match(await fs.readFile(marker, 'utf8'), /executed/);
  } finally { await s.close(); }
});

test('archive restoration checks current and archived trust before checkout and rolls denied moves back', async () => {
  const { server: s, project: p, task: t } = await setup();
  try {
    const root = s.app.ws.projectDir(p.id);
    const marker = path.join(s.app.ws.root, 'checkout-marker');
    const filter = path.join(s.app.ws.root, 'smudge.ts');
    await fs.writeFile(filter, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'checkout\\n'); process.stdin.pipe(process.stdout);`);
    await fs.writeFile(path.join(root, '.gitattributes'), 'source.txt filter=restore\n');
    await fs.writeFile(path.join(root, 'source.txt'), 'retained bytes\n');
    await gitOk(root, ['add', '.gitattributes', 'source.txt']);
    await gitOk(root, ['commit', '-m', 'checkout fixture']);
    await s.app.worktree.prepare(p.id, t.id);
    assert.equal((await s.api('POST', '/api/task/archive', { project: p.id, task: t.id, force: true })).status, 200);
    const [entry] = await s.app.archive.list(p.id);
    assert.ok(entry);
    await gitOk(root, ['config', 'filter.restore.smudge', `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`]);
    const update = async (state: 'restricted' | 'trusted') => {
      const view = await s.app.trust.view(p.id);
      await s.app.trust.update(p.id, { state, overrides: {}, revision: view.revision, confirmed: true });
    };
    await update('restricted');
    assert.equal((await s.api('POST', '/api/archive/restore', { project: p.id, key: entry.key })).status, 403);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    await assert.rejects(s.app.tasks.get(p.id, t.id));
    assert.equal((await s.app.archive.list(p.id))[0]?.key, entry.key);
    await update('trusted');
    assert.equal((await s.api('POST', '/api/archive/restore', { project: p.id, key: entry.key })).status, 200);
    assert.equal(await fs.readFile(path.join(s.app.ws.worktreeDir(p.id, t.id), 'source.txt'), 'utf8'), 'retained bytes\n');
    assert.match(await fs.readFile(marker, 'utf8'), /checkout/);
    assert.equal((await s.api('POST', '/api/project/archive', { project: p.id, force: true })).status, 200);
    const [projectEntry] = await s.app.archive.list();
    assert.ok(projectEntry);
    const archivedRoot = path.join(s.app.ws.projectsDir, '.trash', projectEntry.key);
    const trustFile = path.join(archivedRoot, '.ai', 'trust.json');
    const saved = JSON.parse(await fs.readFile(trustFile, 'utf8')) as { state: string };
    saved.state = 'restricted';
    await fs.writeFile(trustFile, JSON.stringify(saved));
    await fs.rm(marker, { force: true });
    assert.equal((await s.api('POST', '/api/archive/restore', { key: projectEntry.key })).status, 403);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    await assert.rejects(fs.access(root), { code: 'ENOENT' });
    assert.equal((await s.app.archive.list())[0]?.key, projectEntry.key);
  } finally { await s.close(); }
});

test('neither the app page nor the API can be framed by another site', async () => {
  const s = await startTestServer();
  try {
    const dir = await fs.mkdtemp(path.join(s.dir, 'ui-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html>');
    for (const pathname of ['/', '/api/state']) assert.equal((await fetch(s.base + pathname)).headers.get('x-frame-options'), 'DENY');
    // The page's own CSP also forbids ancestors, since some embedders ignore X-Frame-Options.
    const { serveStatic } = await import('./static.ts');
    const headers: Record<string, unknown> = {};
    await serveStatic(dir, { url: '/', method: 'GET' } as never, { writeHead: (_: number, values: Record<string, unknown>) => { Object.assign(headers, values); }, end: () => undefined } as never);
    assert.match(String(headers['Content-Security-Policy']), /frame-ancestors 'none'/);
  } finally { await s.close(); }
});

test('static UI files never follow a link to a file outside the UI folder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-link-'));
  const ui = path.join(dir, 'ui'); await fs.mkdir(ui);
  await fs.writeFile(path.join(dir, 'secret.txt'), 'outside'); await fs.writeFile(path.join(ui, 'app.js'), 'inside');
  await fs.symlink('../secret.txt', path.join(ui, 'link.txt')); await fs.symlink('app.js', path.join(ui, 'alias.js'));
  const { serveStatic } = await import('./static.ts');
  const server = http.createServer((req, res) => void serveStatic(ui, req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const outside = await fetch(`${base}/link.txt`);
    assert.equal(outside.status, 404); assert.doesNotMatch(await outside.text(), /outside/);
    assert.equal(await (await fetch(`${base}/alias.js`)).text(), 'inside', 'a link that stays inside still serves');
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('project order only stores existing projects under an existing parent', async () => {
  const s = await startTestServer();
  try {
    const a = (await s.api('POST', '/api/project/new', { name: 'A' })).json as Project;
    const b = (await s.api('POST', '/api/project/new', { name: 'B' })).json as Project;
    const saved = await s.api('POST', '/api/order', { parent: '', order: [b.id, 'Ghost', a.id, ...Array.from({ length: 2000 }, (_, i) => `x${i}`)] });
    assert.deepEqual((saved.json as { order: string[] }).order, [b.id, a.id]);
    assert.equal((await s.api('POST', '/api/order', { parent: 'Ghost', order: [a.id] })).status, 404);
    const stored = JSON.parse(await fs.readFile(path.join(s.app.ws.internalDir, 'order.json'), 'utf8')) as { order: Record<string, string[]> };
    assert.deepEqual(stored.order, { '': [b.id, a.id] });
  } finally { await s.close(); }
});

test('a malformed percent-encoded page path is a bad request, not an internal error', async () => {
  const s = await startTestServer();
  try {
    for (const pathname of ['/%E0%A4%A', '/assets/%ZZ']) assert.equal((await fetch(s.base + pathname)).status, 400);
  } finally { await s.close(); }
});

test('a task cannot be confirmed done while its AI turn is still running', async () => {
  const { server: s, project: p, task: t } = await setup();
  const ids = { project: p.id, task: t.id };
  try {
    assert.equal((await s.api('POST', '/api/chat/send', { ...ids, ai: 'mock', text: 'work [slow]' })).status, 200);
    for (const [route, body] of [
      ['/api/task/completion', { ...ids, action: 'approve' }],
      ['/api/task/update', { ...ids, patch: { state: '完成' } }],
      ['/api/task/bulk', { project: p.id, tasks: [t.id], action: { kind: 'state', value: '完成' } }],
    ] as const) {
      const response = await s.api('POST', route, body);
      const detail = route === '/api/task/bulk' ? (response.json as { results: { detail?: string }[] }).results[0]?.detail : (response.json as { detail?: string }).detail;
      assert.equal(detail, 'complete_while_running', route);
    }
    assert.notEqual((await s.app.tasks.get(p.id, t.id)).state, '完成');
    assert.equal(await s.app.completion.isApproved(p.id, t.id), false);
    await s.app.runner.stop(p.id, t.id); await s.app.runner.whenIdle();
    assert.equal((await s.api('POST', '/api/task/completion', { ...ids, action: 'approve' })).status, 200);
    assert.equal(await s.app.completion.isApproved(p.id, t.id), true);
  } finally { await s.close(); }
});
