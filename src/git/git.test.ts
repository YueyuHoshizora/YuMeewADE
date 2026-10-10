import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AppError } from '../shared/errors.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ensureRepo, git, gitOk } from './git.ts';

test('deadline stops git and its sleeping editor and surfaces a generic git error', () => withTmpWorkspace(async (_ws, tmp) => {
  const repo = path.join(tmp, 'repo');
  // This integration deadline must use the platform clock to prove a real descendant is killed.
  await fs.mkdir(repo);
  await ensureRepo(repo);
  const script = path.join(tmp, 'editor.ts');
  const pidFile = path.join(tmp, 'editor.pid');
  await fs.writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const args = ['-c', `core.editor="${process.execPath}" "${script}"`, 'commit', '--allow-empty'];
  const result = await git(repo, args, { timeoutMs: 1000 });
  assert.equal(result.code, -1);
  assert.match(result.stderr, /timed out/);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), (err: unknown) => (err as NodeJS.ErrnoException).code === 'ESRCH');
  await assert.rejects(gitOk(repo, args, { timeoutMs: 1000 }), (err: unknown) => err instanceof AppError && err.detail === 'git_failed');
}));

test('gitOk rejects incomplete output while git exposes truncation explicitly', () => withTmpWorkspace(async (_ws, tmp) => {
  const repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'long-filename.txt'), 'test');
  await ensureRepo(repo);
  const args = ['ls-files', '-z'];
  const result = await git(repo, args, { maxBytes: 3 });
  assert.equal(result.code, 0);
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 3);
  await assert.rejects(gitOk(repo, args, { maxBytes: 3 }), (err: unknown) => err instanceof AppError && err.detail === 'git_failed');
}));
