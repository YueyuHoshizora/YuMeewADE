import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { startTestServer } from '../../testing/server.ts';
import { MockCliProvider } from '../../cli/mock.ts';
import type { BudgetCheck, UsageScope } from '../../shared/usage-history-types.ts';

for (const taskScoped of [false, true]) {
  test(taskScoped ? 'workflow parent-task budget blocks branch execution without acknowledgment' : 'workflow consumes parent preflight acknowledgment while recording branch usage', async () => {
    let calls = 0;
    const provider = new MockCliProvider({ chunkMs: 1, text: () => { calls++; return 'ok'; } });
    const s = await startTestServer('', { providers: { codex: provider } });
    try {
      await fs.writeFile(s.app.ws.rolesFile, 'roles:\n  expert:\n    main: [codex, "", ""]\n    job: ""\n');
      await s.app.projects.create({ name: 'P' });
      const task = await s.app.tasks.create('P', { title: 'Workflow budget' });
      await s.app.workflows.configure('P', task.id, [], [{ id: 'work', role: 'expert', text: 'do work', review: false }]);
      await s.app.usageHistory.saveSettings({ rules: [{ id: 'limit', project: 'P', ...(taskScoped ? { task: task.id } : {}), unit: 'tokens', threshold: 10, since: '2020-01-01T00:00:00Z' }], quotaRemainingPercent: null, cloudExpiryHours: null });
      await s.app.usageHistory.record({ project: 'P', task: task.id, ai: 'codex', account: 'default', requestId: 'seed', usage: { input: 10, output: 1 } });
      const next = await s.api('GET', `/api/task/workflow/next?project=P&task=${task.id}`);
      assert.equal(next.status, 200);
      const scope = next.json as UsageScope;
      assert.deepEqual(scope, { project: 'P', task: task.id, ai: 'codex', account: 'default' });
      const check = await s.api('POST', '/api/usage/check', scope);
      assert.equal(check.status, 200);
      const budget = check.json as BudgetCheck;
      assert.equal(budget.warnings.length, 1);
      assert.equal(budget.warnings[0]?.reported, 11);
      if (!taskScoped) assert.equal((await s.api('POST', '/api/usage/ack', { ...scope, acknowledgment: budget.acknowledgment })).status, 200);
      const finished = Promise.withResolvers<void>();
      let observedBusy = false;
      const changed = s.app.changed.bind(s.app);
      s.app.changed = (project, taskId) => {
        changed(project, taskId);
        if (project === 'P' && taskId === task.id) {
          if (s.app.workflows.isBusy('P', task.id)) observedBusy = true;
          else if (observedBusy) finished.resolve();
        }
      };
      assert.equal((await s.api('POST', '/api/task/workflow/start', { project: 'P', task: task.id })).status, 200);
      await finished.promise;
      const plan = await s.app.workflows.get('P', task.id);
      assert.equal(plan.state, taskScoped ? 'failed' : 'completed');
      assert.equal(calls, taskScoped ? 0 : 1);
      const branch = plan.branchTasks?.work;
      assert.ok(branch);
      assert.notEqual(branch, task.id);
      assert.equal(plan.results[0]?.task, branch);
      assert.equal(plan.results[0]?.ok, !taskScoped);
      const history = await s.app.usageHistory.view({ project: 'P' });
      assert.deepEqual(history.records.filter(entry => entry.requestId !== 'seed').map(entry => entry.task), taskScoped ? [] : [branch]);
      if (!taskScoped) await assert.rejects(s.app.usageHistory.assertProceed(scope, s.app.usage.snapshot()), { detail: 'usage_ack_required' });
    } finally { await s.close(); }
  });
}
