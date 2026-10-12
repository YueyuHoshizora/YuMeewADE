import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from './workspace.ts';
import { ProjectLedger } from './projects.ts';
import { TaskLedger } from './tasks.ts';
import { SettingsStore } from './settings.ts';
import { ProjectTrustService } from './trust.ts';
import { parseConfig } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';

test('project permission overrides persist independently and restricted projects reject execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ymae-trust-'));
  try {
    const ws = new Workspace(root); await ws.init();
    const projects = new ProjectLedger(ws); await projects.create({ name: 'P' }); await projects.create({ name: 'Q' });
    const settings = new SettingsStore(ws, parseConfig(`workspace:\n  root: ${JSON.stringify(root)}`, null));
    const trust = new ProjectTrustService(ws, projects, new TaskLedger(ws), settings);
    assert.equal(await trust.fullAccess('P', 'codex', true), true);
    const current = await trust.view('P');
    await trust.update('P', { state: 'trusted', overrides: { codex: false }, revision: current.revision, confirmed: true });
    assert.equal(await trust.fullAccess('P', 'codex', true), false);
    assert.equal(await trust.fullAccess('Q', 'codex', true), true);
    const reopened = new ProjectTrustService(ws, projects, new TaskLedger(ws), settings);
    assert.equal((await reopened.view('P')).overrides.codex, false);
    await assert.rejects(trust.update('P', { state: 'restricted', overrides: {}, revision: current.revision, confirmed: true }), (err: unknown) => err instanceof AppError && err.detail === 'project_trust_changed');
    await trust.update('P', { state: 'restricted', overrides: {}, revision: (await trust.view('P')).revision, confirmed: true });
    await assert.rejects(trust.assertExecutable('P'), (err: unknown) => err instanceof AppError && err.detail === 'project_restricted');
    await trust.assertExecutable('Q');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('trust is invalidated by code-root changes and reapproval must use the current fingerprint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ymae-trust-root-'));
  try {
    const ws = new Workspace(root); await ws.init();
    const projects = new ProjectLedger(ws); await projects.create({ name: 'P' });
    const settings = new SettingsStore(ws, parseConfig(`workspace:\n  root: ${JSON.stringify(root)}`, null));
    const trust = new ProjectTrustService(ws, projects, new TaskLedger(ws), settings);
    const current = await trust.view('P');
    const approved = await trust.update('P', { state: 'trusted', overrides: {}, revision: current.revision, confirmed: true });
    const changedRoot = path.join(root, 'other-code'); await fs.mkdir(changedRoot);
    await projects.update('P', { body: changedRoot });
    const changed = await trust.view('P');
    assert.equal(changed.state, 'restricted'); assert.equal(changed.rootChanged, true);
    await assert.rejects(trust.fullAccess('P', 'codex', true), (err: unknown) => err instanceof AppError && err.detail === 'project_restricted');
    await assert.rejects(trust.update('P', { state: 'trusted', overrides: {}, revision: approved.revision, confirmed: true }), (err: unknown) => err instanceof AppError && err.detail === 'project_trust_changed');
    await trust.update('P', { state: 'trusted', overrides: { codex: false }, revision: changed.revision, confirmed: true });
    assert.equal(await trust.fullAccess('P', 'codex', true), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a main folder moved or deleted outside the app is reported as missing, not as an internal error', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ymae-trust-gone-'));
  try {
    const ws = new Workspace(root); await ws.init();
    const body = path.join(root, 'code'); await fs.mkdir(body);
    const projects = new ProjectLedger(ws); await projects.create({ name: 'P', body });
    const trust = new ProjectTrustService(ws, projects, new TaskLedger(ws), new SettingsStore(ws, parseConfig(`workspace:\n  root: ${JSON.stringify(root)}`, null)));
    await trust.view('P');
    await fs.rename(body, path.join(root, 'moved'));
    const missing = (err: unknown) => err instanceof AppError && err.status === 404 && err.detail === 'project_body_missing';
    await assert.rejects(trust.view('P'), missing);
    await assert.rejects(trust.assertExecutable('P'), missing);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
