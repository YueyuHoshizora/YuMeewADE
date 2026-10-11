import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { github, parseIssue, parsePullRequest } from './github.ts';

const fixture = { number: 12, title: 'Fix', url: 'https://github.com/o/r/pull/12', state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }, { context: 'legacy', state: 'SUCCESS' }], reviews: [{ author: { login: 'a' }, body: 'Please fix', state: 'CHANGES_REQUESTED' }], comments: [] };
test('PR parsing keeps CI, reviews, bounded threads and rejects malformed responses', () => {
  const pr = parsePullRequest(fixture, [{ isResolved: true, path: 'a.ts', line: 2, comments: { nodes: [{ author: { login: 'b' }, body: 'done', url: 'javascript:bad' }] } }]);
  assert.equal(pr.reviewDecision, 'CHANGES_REQUESTED'); assert.equal(pr.checks[1]?.status, 'SUCCESS'); assert.equal(pr.threads[0]?.comments[0]?.url, ''); assert.equal(pr.threads[0]?.resolved, true);
  assert.throws(() => parsePullRequest({}, [])); assert.throws(() => parsePullRequest(fixture, null));
  assert.equal(parsePullRequest({ ...fixture, comments: Array(40).fill({ body: 'x'.repeat(5000) }) }, Array(40).fill({})).comments.length, 30);
});
test('fake gh supports review, missing PR, unauthenticated, invalid JSON and subprocess failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-test-'));
  try {
    const command = path.join(dir, 'gh');
    for (const mode of ['ok', 'none', 'auth', 'bad', 'fail']) {
      await fs.writeFile(command, `#!${process.execPath}\nconst args=process.argv.slice(2); const mode=${JSON.stringify(mode)};\nif(args[0]==='auth')process.exit(mode==='auth'?1:0);\nif(args[0]==='repo'){console.log('o/r');process.exit(0)}\nif(mode==='fail')process.exit(1);\nif(mode==='bad'){console.log('invalid');process.exit(0)}\nconsole.log(JSON.stringify(args[0]==='api'?[]:args[1]==='list'?(mode==='none'?[]:[{number:12}]):${JSON.stringify(fixture)}));\n`, { mode: 0o700 });
      if (mode === 'bad' || mode === 'fail') await assert.rejects(github(dir, { action: 'review', branch: 'topic' }, command));
      else { const result = await github(dir, { action: 'review', branch: 'topic' }, command); assert.equal(result.authenticated, mode !== 'auth'); assert.equal(result.pr?.number ?? null, mode === 'ok' ? 12 : null); }
    }
    assert.equal((await github(dir, { action: 'review', branch: 'topic' }, path.join(dir, 'missing'))).available, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('issue parser rejects malformed identity and bounds body', () => {
  assert.equal(parseIssue({ number: 3, title: 'Issue', body: 'x'.repeat(20000), url: 'https://github.com/o/r/issues/3' }).body.length, 10000);
  for (const value of [{}, { number: -1 }, { number: 3, title: 'Issue', url: 'javascript:bad' }]) assert.throws(() => parseIssue(value));
});
