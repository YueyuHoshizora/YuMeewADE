import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoreHost } from './host.ts';
import { parseConfig } from '../shared/config.ts';
import { MockCliProvider } from '../cli/mock.ts';
import { seedUpgradeFixture, assertUpgradeFixture } from '../testing/upgrade-fixture.ts';

test('legacy ledgers, conversation, attachment and recovery bytes survive startup and restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yumeewade-upgrade-'));
  try {
    const root = path.join(directory, 'workspace');
    const retained = await seedUpgradeFixture(root);
    const config = parseConfig(`server:\n  port: 38241\nworkspace:\n  root: ${JSON.stringify(root)}\nupdate:\n  enabled: false\n`, path.join(directory, 'config.yaml'));
    for (let generation = 0; generation < 2; generation++) {
      const host = new CoreHost(config, { app: { providers: { mock: new MockCliProvider(1) }, home: path.join(directory, 'home') } });
      try {
        await host.init();
        const project = await host.app.projects.get('UpgradeRetained');
        assert.equal(project.description, 'retained legacy project');
        assert.deepEqual(project.checks, []);
        const task = await host.app.tasks.get(project.id, '20261011-001');
        assert.equal(task.title, 'Retained legacy task');
        assert.deepEqual(task.steps, [{ text: 'Already completed', done: true }, { text: 'Preserve next step', done: false }]);
        assert.equal(task.memo, '保留人工備註');
        const log = await host.app.store.readLog(project.id, task.id);
        assert.equal(log[0]?.text, '保留歷史對話');
        await assertUpgradeFixture(root, retained);
      } finally { await host.shutdown(); host.close(); }
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
