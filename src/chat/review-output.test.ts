import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseReviewOutput, reviewFingerprint } from './review-output.ts';

test('successful prose and malformed structured review never grant approval', () => {
  for (const text of ['APPROVED', 'No findings. Approved.', '{"approved":true,"findings":[]}', '```json\n{"schema":1,"approved":true,"findings":[]}\n```']) {
    assert.equal(parseReviewOutput(text).approved, false);
    assert.equal(parseReviewOutput(text).structured, false);
  }
  assert.equal(parseReviewOutput('{"schema":1,"approved":false,"findings":[]}').approved, false);
  assert.equal(parseReviewOutput('{"schema":1,"approved":true,"findings":[]}').approved, true);
});
test('findings require evidence, safe location and severity; major findings veto approval', () => {
  const finding = { severity: 'major', path: 'src/a.ts', line: 2, message: 'Broken condition', evidence: 'line 2 accepts an invalid token' };
  const parse = (item: unknown) => parseReviewOutput(JSON.stringify({ schema: 1, approved: true, findings: [item] }));
  const result = parse(finding);
  assert.equal(result.structured, true); assert.equal(result.approved, false);
  assert.equal(result.findings[0]?.state, 'open'); assert.deepEqual(result.findings[0]?.transitions, []);
  for (const invalid of [{ ...finding, path: '../outside' }, { ...finding, evidence: '' }, { ...finding, line: 0 }, { ...finding, severity: 'urgent' }, { ...finding, severity: ['critical'] }, { ...finding, severity: ['major'] }]) assert.equal(parse(invalid).structured, false);
  assert.equal(parseReviewOutput(JSON.stringify({ schema: 1, approved: true, findings: [{ ...finding, severity: ['critical'] }] })).approved, false);
});
test('content fingerprints detect same-size edits, new files and deletions without git', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-content-'));
  try {
    await fs.writeFile(path.join(dir, 'a.ts'), 'before'); const before = await reviewFingerprint(dir);
    await fs.writeFile(path.join(dir, 'a.ts'), 'after!'); const after = await reviewFingerprint(dir);
    assert.notEqual(before.content, after.content);
    await fs.writeFile(path.join(dir, 'b.ts'), 'new'); const added = await reviewFingerprint(dir);
    assert.notEqual(added.content, after.content);
    await fs.unlink(path.join(dir, 'b.ts')); assert.equal((await reviewFingerprint(dir)).content, after.content);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('a project\'s own .ai files count as content; only the ledger folder\'s top-level .ai is left out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ai-'));
  try {
    await fs.mkdir(path.join(dir, '.ai'), { recursive: true }); await fs.mkdir(path.join(dir, 'pkg', '.ai'), { recursive: true });
    await fs.writeFile(path.join(dir, '.ai', 'rules.md'), 'one'); await fs.writeFile(path.join(dir, 'pkg', '.ai', 'x.md'), 'one');
    const external = await reviewFingerprint(dir, path.join(os.tmpdir(), 'some-other-ledger'));
    await fs.writeFile(path.join(dir, '.ai', 'rules.md'), 'two');
    assert.notEqual((await reviewFingerprint(dir, path.join(os.tmpdir(), 'some-other-ledger'))).content, external.content);
    const ledger = await reviewFingerprint(dir, dir);
    await fs.writeFile(path.join(dir, '.ai', 'rules.md'), 'three');
    assert.equal((await reviewFingerprint(dir, dir)).content, ledger.content, 'ledger bookkeeping is not reviewed content');
    await fs.writeFile(path.join(dir, 'pkg', '.ai', 'x.md'), 'two');
    assert.notEqual((await reviewFingerprint(dir, dir)).content, ledger.content, 'nested .ai directories are project content');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('bytes moved between files never reproduce a fingerprint, and a staged submodule commit changes it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-frames-'));
  try {
    await fs.writeFile(path.join(dir, 'a.bin'), ''); await fs.writeFile(path.join(dir, 'b.bin'), '');
    // The old hash input was name NUL bytes mode NUL per file, so these two trees used to hash identically.
    const mode = String((await fs.stat(path.join(dir, 'a.bin'))).mode);
    await fs.writeFile(path.join(dir, 'a.bin'), `X${mode}\0b.bin\0Y`); await fs.writeFile(path.join(dir, 'b.bin'), 'Z');
    const before = await reviewFingerprint(dir);
    await fs.writeFile(path.join(dir, 'a.bin'), 'X'); await fs.writeFile(path.join(dir, 'b.bin'), `Y${mode}\0b.bin\0Z`);
    assert.notEqual((await reviewFingerprint(dir)).content, before.content);
    // A submodule: only its staged commit changes, no file of the superproject does.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString();
    const repo = path.join(dir, 'repo'); const dep = path.join(repo, 'dep');
    await fs.mkdir(dep, { recursive: true }); run(repo, 'init', '-q'); run(dep, 'init', '-q');
    await fs.writeFile(path.join(dep, 'x.txt'), 'one'); run(dep, 'add', '.'); run(dep, 'commit', '-qm', 'one');
    run(repo, 'add', 'dep'); run(repo, 'commit', '-qm', 'add dep');
    const reviewed = await reviewFingerprint(repo);
    await fs.writeFile(path.join(dep, 'x.txt'), 'two'); run(dep, 'commit', '-qam', 'two'); run(repo, 'add', 'dep');
    assert.notEqual((await reviewFingerprint(repo)).content, reviewed.content);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
