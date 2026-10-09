import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectLedger } from '../ledger/projects.ts';
import { AppError } from '../shared/errors.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { git } from './git.ts';
import { WorktreeService } from './worktree.ts';

test('worktree：建立 → 改檔 → diff → 收編 → 本體含變更；.ai/ 不進 git', () =>
  withTmpWorkspace(async (ws) => {
    await new ProjectLedger(ws).create('P');
    const wt = new WorktreeService(ws, 100_000);
    const before = await wt.status('P', 'T1');
    assert.equal(before.exists, false);

    const dir = await wt.ensure('P', 'T1');
    assert.equal(dir, ws.worktreeDir('P', 'T1'));
    assert.equal(await wt.ensure('P', 'T1'), dir); // 冪等
    assert.equal(await fs.access(path.join(dir, 'PROJECT.md')).then(() => true), true);
    await assert.rejects(fs.access(path.join(dir, '.ai')), 'worktree 不應有 .ai/');

    await fs.writeFile(path.join(dir, 'hello.txt'), 'hi\n');
    await fs.appendFile(path.join(dir, 'PROJECT.md'), '改了\n');
    const status = await wt.status('P', 'T1');
    assert.equal(status.exists, true);
    assert.equal(status.branch, 'ym/T1');
    assert.deepEqual(status.dirty.sort(), ['PROJECT.md', 'hello.txt']);

    const d = await wt.diff('P', 'T1');
    assert.match(d.diff, /\+改了/);
    assert.match(d.diff, /\+hi/);
    assert.equal(d.truncated, false);

    const merged = await wt.merge('P', 'T1', '第一件');
    assert.equal(merged.merged, true);
    const repo = ws.projectDir('P');
    assert.match(await fs.readFile(path.join(repo, 'hello.txt'), 'utf8'), /hi/);
    assert.match((await git(repo, ['log', '--oneline'])).stdout, /收編 T1: 第一件/);
    assert.match((await git(repo, ['ls-files'])).stdout, /PROJECT\.md/);
    assert.doesNotMatch((await git(repo, ['ls-files'])).stdout, /\.ai\//);

    await wt.remove('P', 'T1');
    assert.equal((await wt.status('P', 'T1')).exists, false);
    await assert.rejects(wt.remove('P', 'T1'), (e: unknown) => e instanceof AppError && e.code === 'not_found');
  }));

test('worktree：衝突時中止，本體不變；未提交時拒絕移除', () =>
  withTmpWorkspace(async (ws) => {
    await new ProjectLedger(ws).create('P');
    const wt = new WorktreeService(ws, 100_000);
    const dir = await wt.ensure('P', 'T2');
    const repo = ws.projectDir('P');
    await fs.writeFile(path.join(repo, 'PROJECT.md'), '---\nname: P\nstatus: 進行中\nupdated: x\n---\n本體版\n');
    await fs.writeFile(path.join(dir, 'PROJECT.md'), '---\nname: P\nstatus: 暫停\nupdated: y\n---\n副本版\n');
    const r = await wt.merge('P', 'T2', '衝突');
    assert.equal(r.merged, false);
    assert.deepEqual(r.conflicts, ['PROJECT.md']);
    assert.match(await fs.readFile(path.join(repo, 'PROJECT.md'), 'utf8'), /本體版/);
    assert.equal((await git(repo, ['status', '--porcelain'])).stdout.trim(), '');
    await fs.writeFile(path.join(dir, 'new.txt'), 'x');
    await assert.rejects(wt.remove('P', 'T2'), (e: unknown) => e instanceof AppError && e.code === 'conflict');
  }));

test('建立副本時複製未追蹤的 .env／.npmrc，已追蹤的不重複；範本 rules.md 存在', () =>
  withTmpWorkspace(async (ws) => {
    await new ProjectLedger(ws).create('P');
    const repo = ws.projectDir('P');
    assert.match(await fs.readFile(path.join(repo, '.ai', 'rules.md'), 'utf8'), /共用規則/);
    assert.match(await fs.readFile(path.join(repo, 'CLAUDE.md'), 'utf8'), /Claude Code/);
    await fs.writeFile(path.join(repo, '.env'), 'SECRET=1\n');
    await fs.writeFile(path.join(repo, '.npmrc'), 'registry=x\n');
    await fs.writeFile(path.join(repo, 'other.txt'), 'no\n');
    const wt = new WorktreeService(ws, 100_000);
    const dir = await wt.ensure('P', 'T3');
    assert.equal(await fs.readFile(path.join(dir, '.env'), 'utf8'), 'SECRET=1\n');
    assert.equal(await fs.readFile(path.join(dir, '.npmrc'), 'utf8'), 'registry=x\n');
    await assert.rejects(fs.access(path.join(dir, '.ai')));
    // .env 在副本中是被 .gitignore 忽略的，不會進 diff
    assert.doesNotMatch((await wt.diff('P', 'T3')).diff, /SECRET/);
  }));
