import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

test('Git reads never execute repository fsmonitor, external diff or textconv programs', () => withTmpWorkspace(async (_ws, tmp) => {
  const repo = path.join(tmp, 'repo'); await fs.mkdir(repo); await fs.writeFile(path.join(repo, 'file.txt'), 'old\n'); await ensureRepo(repo);
  const marker = path.join(tmp, 'executed'); const program = path.join(tmp, 'integration.ts');
  await fs.writeFile(program, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdout.write('converted');`);
  const command = `"${process.execPath}" "${program}"`;
  await gitOk(repo, ['config', 'core.fsmonitor', command]);
  await gitOk(repo, ['config', 'diff.external', command]);
  await gitOk(repo, ['config', 'diff.convert.textconv', command]);
  await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt diff=convert\n'); await fs.writeFile(path.join(repo, 'file.txt'), 'new\n');
  const status = await gitOk(repo, ['status', '--porcelain']); assert.match(status, /file.txt/u);
  const diff = await gitOk(repo, ['diff', '--', 'file.txt']); assert.match(diff, /\+new/u); assert.match(diff, /-old/u);
  assert.equal(await fs.stat(marker).catch(() => null), null);
}));

for (const identity of ['local', 'global', 'name-only', 'email-only', 'missing']) test(`commit identity uses configured fields with fallback only when missing: ${identity}`, () => withTmpWorkspace(async (_ws, tmp) => {
  const home = path.join(tmp, 'home'); await fs.mkdir(home);
  const globalConfig = path.join(home, 'gitconfig');
  await fs.writeFile(globalConfig, identity === 'global' ? '[user]\nname = Global Developer\nemail = global@example.test\n' : '');
  const script = path.join(tmp, 'identity.ts');
  const repo = path.join(tmp, 'repo'); await fs.mkdir(repo);
  await fs.writeFile(script, `
import assert from 'node:assert/strict';
import { gitOk } from ${JSON.stringify(new URL('./git.ts', import.meta.url).href)};
const repo = ${JSON.stringify(repo)};
await gitOk(repo, ['init', '-q']);
const identity = ${JSON.stringify(identity)};
if (identity === 'local' || identity === 'name-only') await gitOk(repo, ['config', 'user.name', 'Actual Developer']);
if (identity === 'local' || identity === 'email-only') await gitOk(repo, ['config', 'user.email', 'developer@example.test']);
await gitOk(repo, ['commit', '--allow-empty', '-m', 'identity regression']);
const name = identity === 'global' ? 'Global Developer' : identity === 'local' || identity === 'name-only' ? 'Actual Developer' : 'YuMeewADE';
const email = identity === 'global' ? 'global@example.test' : identity === 'local' || identity === 'email-only' ? 'developer@example.test' : 'yumeewade@localhost';
assert.equal((await gitOk(repo, ['show', '-s', '--format=%an <%ae> | %cn <%ce>', 'HEAD'])).trim(), name + ' <' + email + '> | ' + name + ' <' + email + '>');
const tree = (await gitOk(repo, ['rev-parse', 'HEAD^{tree}'])).trim();
const snapshot = (await gitOk(repo, ['commit-tree', tree, '-p', 'HEAD', '-m', 'snapshot'])).trim();
assert.equal((await gitOk(repo, ['show', '-s', '--format=%an <%ae> | %cn <%ce>', snapshot])).trim(), name + ' <' + email + '> | ' + name + ' <' + email + '>');
`);
  const result = await promisify(execFile)(process.execPath, [script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(result.stderr, '');
}));
