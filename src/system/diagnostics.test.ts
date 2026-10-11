import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { diagnosticPayload, CareService } from './diagnostics.ts';
import { Workspace } from '../ledger/workspace.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import type { CareHealth, Settings } from '../shared/types.ts';

const settings: Settings = { initial: { ai: 'mock', model: '', effort: '' }, hiddenModels: {}, modelOrder: {}, fullAccess: {}, accounts: {}, activeAccounts: {} };
const health: CareHealth = {
  checkedAt: 'SECRET_TIME', node: '24.1.0', electron: null, git: { available: true, version: '2.49.0' }, writable: true, loopback: true, boundToLoopback: true,
  network: 'not-tested', buildTrust: 'unknown', clis: [{ name: 'codex', available: true, version: '1.0.0', fullAccess: true, configuredAccounts: 1, loginState: 'stored' }],
};
test('diagnostic allowlist excludes injected secrets and arbitrary strings', () => {
  const injected = { ...health, node: 'TOKEN_SECRET', argv: ['ARG_SECRET'], env: { token: 'ENV_SECRET' }, prompt: 'PROMPT_SECRET', chats: ['CHAT_SECRET'], path: '/SECRET_HOME', credentials: 'CREDENTIAL_SECRET', quota: 'QUOTA_SECRET', clis: [...health.clis, { ...health.clis[0]!, name: 'NAME_SECRET', version: 'VERSION_SECRET' }], git: { available: true, version: 'GIT_SECRET' } };
  const output = JSON.stringify(diagnosticPayload(injected, 'APP_SECRET', { projects: 2, tasks: 3, running: 0 }));
  assert.doesNotMatch(output, /SECRET|TOKEN|PROMPT|CHAT|CREDENTIAL|QUOTA/);
  const payload = JSON.parse(output);
  assert.equal(payload.configuration.workspace, '[workspace]');
  assert.deepEqual(payload.counts, { projects: 2, tasks: 3, running: 0 });
  assert.equal(payload.providers.length, 1);
});
test('care backup and restore enter exclusive reservation and reject busy before filesystem changes', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'care-busy-'));
  try {
    const ws = new Workspace(path.join(temporary, 'workspace')); await ws.init();
    let reservations = 0;
    const care = new CareService({ ws, config: { ...DEFAULT_CONFIG, workspace: { root: ws.root } }, catalog: { list: async () => [] }, settings: { get: async () => settings }, version: '1.0.0', privateDirectory: path.join(temporary, 'private'), loginState: async () => 'unknown', counts: async () => ({ projects: 0, tasks: 0, running: 1 }), reserve: async () => { reservations++; throw new Error('busy'); } });
    await assert.rejects(care.backup(true), /busy/);
    await assert.rejects(care.restore('bad-id', path.join(temporary, 'restore')), /busy/);
    assert.equal(reservations, 2);
    await assert.rejects(fs.access(path.join(temporary, 'private')));
    await care.close(); await assert.rejects(async () => care.backup(true));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('diagnostics writes a real private export with no state secrets', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'care-diagnostics-'));
  try {
    const ws = new Workspace(path.join(temporary, 'workspace')); await ws.init();
    await fs.writeFile(ws.rolesFile, 'PROMPT_SECRET');
    const directory = path.join(temporary, 'private');
    const care = new CareService({ ws, config: { ...DEFAULT_CONFIG, workspace: { root: ws.root } }, catalog: { list: async () => [] }, settings: { get: async () => settings }, version: '1.0.0', privateDirectory: directory, loginState: async () => 'missing', counts: async () => ({ projects: 0, tasks: 0, running: 0 }), reserve: work => work() });
    const bytes = await care.diagnostics();
    assert.doesNotMatch(bytes.toString(), /PROMPT_SECRET|care-diagnostics-/);
    const files = await fs.readdir(path.join(directory, 'diagnostics'));
    assert.equal(files.length, 1);
    const file = path.join(directory, 'diagnostics', files[0]!);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.equal(JSON.parse(bytes.toString()).format, 1);
    await care.close();
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('scheduled failure is persisted, notified once and shutdown stops scheduling', { timeout: 10000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'care-schedule-'));
  try {
    const ws = new Workspace(path.join(temporary, 'workspace')); await ws.init();
    const directory = path.join(temporary, 'private');
    const options = { ws, config: { ...DEFAULT_CONFIG, workspace: { root: ws.root } }, catalog: { list: async () => [] }, settings: { get: async () => settings }, version: '1.0.0', privateDirectory: directory, loginState: async () => 'unknown' as const, counts: async () => ({ projects: 0, tasks: 0, running: 0 }), reserve: async <T>(_work: () => Promise<T>): Promise<T> => { throw new Error('private busy details'); } };
    const initial = new CareService(options); await initial.init();
    await assert.rejects(initial.setSchedule({ enabled: true, intervalHours: 0, retention: 10, includeExternal: true }));
    await initial.setSchedule({ enabled: true, intervalHours: 1, retention: 2, includeExternal: true }); await initial.close();
    const scheduleFile = path.join(directory, (await fs.readdir(directory)).find(name => name.startsWith('schedule-'))!);
    const fixture = JSON.parse(await fs.readFile(scheduleFile, 'utf8')); fixture.nextAttempt = new Date(Date.now() - 1000).toISOString(); await fs.writeFile(scheduleFile, JSON.stringify(fixture));
    const notified = Promise.withResolvers<void>(); let notifications = 0;
    const service = new CareService({ ...options, notifyBackupFailure: () => { notifications++; notified.resolve(); } }); await service.init();
    await notified.promise; await service.close();
    const stored = JSON.parse(await fs.readFile(scheduleFile, 'utf8'));
    assert.equal(stored.lastFailure, 'care_backup_invalid'); assert.equal(stored.running, false); assert.equal(stored.lastSuccess, null);
    assert.ok(Date.parse(stored.nextAttempt) > Date.now()); assert.equal(notifications, 1);
    assert.doesNotMatch(await fs.readFile(scheduleFile, 'utf8'), /private busy details/);
    await assert.rejects(service.backup(true), { detail: 'care_closed' });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
