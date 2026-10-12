import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { claudeArgs } from '../cli/claude.ts';
import { codexArgs } from '../cli/codex.ts';
import type { CliProvider, SendOptions } from '../cli/provider.ts';
import { MockCliProvider } from '../cli/mock.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { SettingsStore } from '../ledger/settings.ts';
import { WorktreeService } from '../git/worktree.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ChatStore } from './store.ts';
import { ReviewService } from './review.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('review arguments cannot inherit full-access, writing session, ledger dirs or arbitrary tools', () => {
  for (const [builder, cfg] of [[claudeArgs, DEFAULT_CONFIG.cli.claude], [codexArgs, DEFAULT_CONFIG.cli.codex]] as const) {
    const opts = { prompt: 'review', cwd: '/workspace', readonly: true, fullAccess: true };
    const args = builder({ ...cfg, baseArgs: ['--dangerously-skip-permissions'], fullAccessArgs: ['--always-approve'] }, opts);
    assert.ok(!args.includes('--always-approve'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    for (const extra of [{ resumeId: 'writing-session' }, { addDirs: ['/ledger/.ai'] }, { slashCommand: '/edit' }]) assert.throws(() => builder(cfg, { ...opts, ...extra }));
    assert.throws(() => builder({ ...cfg, readonlyArgs: [...cfg.readonlyArgs!, '--dangerously-skip-permissions'] }, opts));
    assert.throws(() => builder({ ...cfg, readonlyArgs: [] }, opts));
  }
  const args = claudeArgs(DEFAULT_CONFIG.cli.claude, { prompt: 'write via Bash', cwd: '/w', readonly: true });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(args.includes('--restricted'));
  assert.equal(codexArgs(DEFAULT_CONFIG.cli.codex, { prompt: 'write', cwd: '/w', readonly: true })[4], 'read-only');
  assert.throws(() => new MockCliProvider().send({ prompt: 'review', cwd: '/w', readonly: true }, () => undefined));
});
test('review provider write request is rejected; transcript persists without changing writing metadata', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); await projects.create({ name: 'P' });
  const tasks = new TaskLedger(ws); const task = await tasks.create('P', { title: 'Review', workspace: 'direct' });
  const settings = new SettingsStore(ws, DEFAULT_CONFIG);
  const store = new ChatStore(ws);
  const meta = { sessions: { codex: 'writing-session' }, models: { codex: 'm' }, seen: { codex: 'seen' } };
  await store.writeMeta('P', task.id, meta);
  const calls: SendOptions[] = [];
  // Test provider performs a permission decision, not an echo: a requested write must be denied.
  const provider: CliProvider = { name: 'policy-test', dangerous: true, supportsReadonly: true, readonlyEnforcement: 'tool-allowlist', available: async () => true,
    send: (opts, onEvent) => {
      calls.push(opts);
      assert.equal(opts.readonly, true); assert.equal(opts.resumeId, undefined); assert.equal(opts.addDirs, undefined); assert.equal(opts.fullAccess, undefined);
      const allowedTools = opts.readonly ? ['Read', 'Glob', 'Grep'] : ['Read', 'Write', 'Bash'];
      assert.equal(allowedTools.includes('Write'), false); assert.equal(allowedTools.includes('Bash'), false);
      onEvent({ type: 'session', id: 'isolated-review-session' });
      onEvent({ type: 'result', text: 'Write denied by tool policy' });
      return { stop() {}, done: Promise.resolve({ ok: true, stopped: false }) };
    },
  };
  const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: DEFAULT_CONFIG.limits.diffBytes });
  let writing = true; let published = 0;
  const service = new ReviewService({ ws, providers: { codex: provider, mock: new MockCliProvider() }, tasks, settings, store, worktree, limits: DEFAULT_CONFIG.limits, onChanged() {}, isRunning: () => writing, publish: () => { published++; } });
  await assert.rejects(service.run('P', task.id, { ai: 'codex', text: 'writing still active' }));
  assert.equal(calls.length, 0);
  writing = false;
  const result = await service.run('P', task.id, { ai: 'codex', text: 'Attempt Write and Bash' });
  assert.equal(result.session, 'isolated-review-session'); assert.equal(result.ok, true);
  assert.equal(result.approved, false); assert.equal(result.structured, false);
  assert.equal((await service.history('P', task.id)).snapshots[0]?.text, 'Write denied by tool policy');
  assert.deepEqual(await store.readMeta('P', task.id), meta);
  assert.equal((await store.readLog('P', task.id)).length, 2);
  assert.equal(published, 2);
  await assert.rejects(service.run('P', task.id, { ai: 'mock', text: 'review' }));
  assert.equal(calls.length, 1); assert.equal(service.isBusy(), false);
  await service.close();
}));

test('stop while user transcript append is pending prevents provider launch', { timeout: 5000 }, () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); await projects.create({ name: 'P' });
  const tasks = new TaskLedger(ws); const task = await tasks.create('P', { title: 'Review', workspace: 'direct' });
  const settings = new SettingsStore(ws, DEFAULT_CONFIG);
  const store = new ChatStore(ws);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = store.append.bind(store);
  store.append = async (p, t, row) => {
    await append(p, t, row);
    if (row.role === 'user') { entered.resolve(); await release.promise; }
  };
  let launches = 0;
  const provider: CliProvider = { name: 'review-test', dangerous: false, supportsReadonly: true, readonlyEnforcement: 'tool-allowlist', available: async () => true,
    send: () => { launches++; return { stop() {}, done: Promise.resolve({ ok: true, stopped: false }) }; } };
  const worktree = new WorktreeService({ ws, projects, tasks, diffBytes: DEFAULT_CONFIG.limits.diffBytes });
  const service = new ReviewService({ ws, providers: { codex: provider }, tasks, settings, store, worktree, limits: DEFAULT_CONFIG.limits, onChanged() {}, isRunning: () => false, publish() {} });
  const running = service.run('P', task.id, { ai: 'codex', text: 'review', model: 'm' });
  const rejected = assert.rejects(running, { code: 'conflict' });
  await entered.promise;
  // While it runs, the review is listed with chat runs and says how it must be stopped.
  assert.deepEqual(service.active().map(info => [info.kind, info.project, info.task, info.ai, info.model]), [['review', 'P', task.id, 'codex', 'm']]);
  assert.equal(service.stop('P', task.id), true);
  release.resolve();
  await rejected;
  assert.equal(launches, 0);
  const last = (await store.readLog('P', task.id)).at(-1);
  assert.ok(last?.role === 'assistant' && last.stopped);
  assert.equal(service.isBusy(), false);
  assert.deepEqual(service.active(), []);
  await service.close();
}));

test('review findings retain evidence and prior snapshots; stale approval blocks merging', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws); await projects.create({ name: 'P' });
  const tasks = new TaskLedger(ws); const task = await tasks.create('P', { title: 'Review', workspace: 'direct' });
  const settings = new SettingsStore(ws, DEFAULT_CONFIG); const store = new ChatStore(ws);
  let text = JSON.stringify({ schema: 1, approved: false, findings: [{ severity: 'major', path: 'a.ts', line: 1, message: 'Failure', evidence: 'invalid branch' }] });
  const provider: CliProvider = { name: 'review-test', dangerous: false, supportsReadonly: true, readonlyEnforcement: 'tool-allowlist', available: async () => true,
    send: (_opts, event) => { event({ type: 'result', text }); return { stop() {}, done: Promise.resolve({ ok: true, stopped: false }) }; } };
  const service = new ReviewService({ ws, providers: { codex: provider }, tasks, settings, store,
    worktree: new WorktreeService({ ws, projects, tasks, diffBytes: DEFAULT_CONFIG.limits.diffBytes }), limits: DEFAULT_CONFIG.limits, isRunning: () => false, onChanged() {}, publish() {} });
  const first = await service.run('P', task.id, { ai: 'codex', text: 'review' });
  assert.equal(first.approved, false);
  await service.setGate('P', task.id, true); await assert.rejects(service.assertMergeAllowed('P', task.id));
  const finding = first.snapshot!.findings[0]!;
  const history = await service.updateFinding('P', task.id, first.request, finding.id, 'resolved', 'Fixed the invalid branch');
  assert.equal(history.snapshots[0]?.findings[0]?.transitions[0]?.evidence, 'Fixed the invalid branch');
  await assert.rejects(service.assertMergeAllowed('P', task.id));
  text = JSON.stringify({ schema: 1, approved: true, findings: [] });
  await service.run('P', task.id, { ai: 'codex', text: 'review again' });
  await service.assertMergeAllowed('P', task.id);
  assert.equal((await service.history('P', task.id)).snapshots.length, 2);
  await fs.writeFile(path.join(ws.projectDir('P'), 'a.ts'), 'changed');
  assert.equal((await service.history('P', task.id)).stale, true);
  await assert.rejects(service.assertMergeAllowed('P', task.id)); await service.close();
}));
