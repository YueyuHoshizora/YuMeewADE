import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockCliProvider } from '../cli/mock.ts';
import type { SendOptions } from '../cli/provider.ts';
import { AppError } from '../shared/errors.ts';
import type { Settings, Task } from '../shared/types.ts';
import { startTestServer } from '../testing/server.ts';

test('command API and normal send keep account context, dispatch native intact, expand custom, and reject unsupported without prose', async () => {
  const calls: SendOptions[] = [];
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-slash-profile-'));
  const provider = Object.assign(new MockCliProvider({ chunkMs: 0, text: opts => { calls.push(opts); return 'done'; } }), {
    commands: async (_cwd: string, configDir?: string) => [{ name: configDir === profile ? 'custom' : 'compact', description: 'Available command' }],
    resolveCommand: async (text: string, _cwd: string, configDir?: string) => {
      if (text === '/compact' && !configDir) return { text, native: true };
      if (text === '/custom argument' && configDir === profile) return { text: 'Expanded argument instructions', native: false };
      throw new AppError('bad_request', 'slash_unsupported');
    },
  });
  const server = await startTestServer('', { providers: { claude: provider } });
  try {
    await server.api('POST', '/api/project/new', { name: 'P' });
    const task = (await server.api('POST', '/api/task/new', { project: 'P', title: 'T', workspace: 'direct', cli: 'claude' })).json as Task;
    const endpoint = `/api/chat/commands?project=P&task=${task.id}&ai=claude`;
    assert.deepEqual((await server.api('GET', endpoint)).json, { commands: [{ name: 'compact', description: 'Available command' }] });
    assert.equal((await server.api('POST', '/api/chat/send', { project: 'P', task: task.id, ai: 'claude', text: '/model fake' })).status, 400);
    assert.equal((await server.app.store.readLog('P', task.id)).length, 0);
    assert.equal(calls.length, 0);
    assert.equal((await server.api('POST', '/api/chat/send', { project: 'P', task: task.id, ai: 'claude', text: '/compact' })).status, 200);
    await server.app.runner.whenIdle();
    assert.equal(calls[0]?.slashCommand, '/compact');
    assert.ok(!calls[0]?.prompt.includes('/compact'));
    const accountSettings = (await server.api('POST', '/api/accounts/add', { ai: 'claude', name: 'Other', configDir: profile })).json as Settings;
    const id = accountSettings.accounts.claude![0]!.id;
    await server.api('POST', '/api/settings', { activeAccounts: { claude: id } });
    assert.deepEqual((await server.api('GET', endpoint)).json, { commands: [{ name: 'compact', description: 'Available command' }] });
    assert.equal((await server.api('POST', '/api/chat/send', { project: 'P', task: task.id, ai: 'claude', text: '/compact' })).status, 200);
    await server.app.runner.whenIdle();
    // Chats run on the default slot even after switching; only the account id for sessions/usage changes.
    assert.equal(calls[1]?.configDir, undefined);
    assert.equal(calls[1]?.accountId, id);
    assert.equal(calls[1]?.resumeId, undefined);
    assert.equal(calls[1]?.slashCommand, '/compact');
    assert.equal((await server.api('GET', `/api/chat/commands?project=P&task=${task.id}&ai=invalid`)).status, 400);
    assert.equal((await server.api('GET', '/api/chat/commands?project=P&task=missing&ai=claude')).status, 404);
  } finally { await server.close(); await fs.rm(profile, { recursive: true, force: true }); }
});
