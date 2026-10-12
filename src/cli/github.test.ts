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

test('feedback uses stable GraphQL IDs, separate variables, explicit confirmation and pinned repo/PR/head', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-feedback-'));
  try {
    const command = path.join(dir, 'gh'), log = path.join(dir, 'calls.jsonl'), state = path.join(dir, 'state.json');
    await fs.writeFile(state, JSON.stringify({ resolved: false }));
    await fs.writeFile(command, `#!${process.execPath}
const fs = require('node:fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a)+'\\n');
if(a[0]==='auth')process.exit(0);
if(a[0]==='repo'){console.log('o/r');process.exit(0)}
if(a[0]!=='api'||a[1]!=='graphql')process.exit(9);
if(a.includes('id=PRRC_1')){console.log(JSON.stringify({id:'PRRC_1',pullRequest:{number:12,url:'https://github.com/o/r/pull/12',repository:{nameWithOwner:'o/r'}}}));process.exit(0)}
if(!a.includes('id=PRRT_123'))process.exit(9);
const query=a.find(v=>v.startsWith('query=')); const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
if(query.startsWith('query=query($id:ID!)')){
 if(!query.includes('pullRequest{number url headRefOid repository{nameWithOwner}}')||!query.includes('nodes{id author{login} body url}'))process.exit(8);
 console.log(JSON.stringify({id:'PRRT_123',isResolved:s.resolved,path:'src/a.ts',line:7,pullRequest:{number:12,url:'https://github.com/o/r/pull/12',headRefOid:'a'.repeat(40),repository:{nameWithOwner:'o/r'}},comments:{nodes:[{id:'PRRC_1',author:{login:'reviewer'},body:'Fix this',url:'https://github.com/o/r/pull/12#discussion_r1'}]}}));process.exit(0)
}
if(query.includes('addPullRequestReviewThreadReply')){
 if(!a.includes('body=quoted \" } mutation { bad }'))process.exit(7);
 console.log(JSON.stringify({data:{addPullRequestReviewThreadReply:{comment:{id:'PRRC_2'}}}}));process.exit(0)
}
const key=query.includes('unresolveReviewThread')?'unresolveReviewThread':'resolveReviewThread'; s.resolved=key==='resolveReviewThread';
fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s));console.log(JSON.stringify({data:{[key]:{thread:{id:'PRRT_123',isResolved:s.resolved}}}}));
`, { mode: 0o700 });
    const base = { repository: 'o/r', number: 12, threadId: 'PRRT_123', kind: 'thread' as const };
    const current = await github(dir, { action: 'feedback-read', ...base }, command);
    assert.equal(current.thread?.comments[0]?.id, 'PRRC_1'); assert.equal(current.thread?.line, 7);
    const write = { action: 'feedback-write' as const, ...base, commentId: 'PRRC_1', operation: 'reply' as const, body: 'quoted " } mutation { bad }', title: '', headOid: 'a'.repeat(40), expectedResolved: false, expectedState: '', confirmed: true };
    for (const changed of [{ confirmed: false }, { repository: 'other/repo' }, { number: 99 }, { headOid: 'b'.repeat(40) }, { expectedResolved: true }, { threadId: '../bad' }]) await assert.rejects(github(dir, { ...write, ...changed }, command));
    const callsBefore = (await fs.readFile(log, 'utf8')).trim().split('\n').map(v => JSON.parse(v) as string[]);
    assert.equal(callsBefore.some(call => call.some(arg => arg.startsWith('query=mutation'))), false);
    await github(dir, write, command);
    assert.equal((await github(dir, { ...write, operation: 'resolve', body: '' }, command)).thread?.resolved, true);
    assert.equal((await github(dir, { ...write, operation: 'unresolve', body: '', expectedResolved: true }, command)).thread?.resolved, false);
    const mutations = (await fs.readFile(log, 'utf8')).trim().split('\n').map(v => JSON.parse(v) as string[]).filter(call => call.some(arg => arg.startsWith('query=mutation')));
    assert.equal(mutations.length, 3); assert.ok(mutations.every(call => call.includes('id=PRRT_123')));
    assert.ok(mutations.every(call => !call.find(arg => arg.startsWith('query='))?.includes('quoted')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('issue feedback mutations use explicit repository REST endpoints and refresh state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-issue-write-'));
  try {
    const command = path.join(dir, 'gh'), state = path.join(dir, 'issue.json'), log = path.join(dir, 'calls.jsonl');
    await fs.writeFile(state, JSON.stringify({ number: 3, title: 'Before', body: 'Initial', state: 'OPEN', url: 'https://github.com/o/r/issues/3', contentVersion: '2026-10-13T00:00:00Z' }));
    await fs.writeFile(command, `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[0]==='auth')process.exit(0);if(a[0]==='repo'){console.log('o/r');process.exit(0)}
const issue=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
if(a[0]==='issue'){if(!a.includes('--repo')||!a.includes('o/r')||a[2]!=='3')process.exit(7);console.log(JSON.stringify(issue));process.exit(0)}
if(a[0]!=='api'||!['repos/o/r/issues/3','repos/o/r/issues/3/comments'].includes(a[1]))process.exit(8);
if(a[1].endsWith('/comments')){if(!a.includes('POST')||!a.includes('body=Reply'))process.exit(9);console.log('{"id":123}');process.exit(0)}
if(!a.includes('PATCH'))process.exit(10);for(const v of a){if(v.startsWith('title='))issue.title=v.slice(6);if(v.startsWith('body='))issue.body=v.slice(5);if(v==='state=closed')issue.state='CLOSED'}
fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(issue));console.log(JSON.stringify(issue));
`, { mode: 0o700 });
    const input = { action: 'feedback-write' as const, repository: 'o/r', number: 3, threadId: '', kind: 'issue' as const, operation: 'update' as const, title: 'Edited', body: 'New body', headOid: '', expectedResolved: false, expectedState: 'OPEN', expectedContentVersion: '2026-10-13T00:00:00Z', confirmed: true };
    await assert.rejects(github(dir, { ...input, confirmed: false }, command));
    assert.equal((await github(dir, input, command)).issue?.title, 'Edited');
    await github(dir, { ...input, operation: 'reply', body: 'Reply' }, command);
    assert.equal((await github(dir, { ...input, operation: 'close' }, command)).issue?.state, 'CLOSED');
    await assert.rejects(github(dir, input, command));
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(v => JSON.parse(v) as string[]);
    assert.equal(calls.filter(call => call[0] === 'api').length, 3);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('review JSON accepts projected maximum escaped bodies and keeps a hard output cap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-output-'));
  try {
    const command = path.join(dir, 'gh');
    for (const overflow of [false, true]) {
      await fs.writeFile(command, `#!${process.execPath}
const a=process.argv.slice(2);if(a[0]==='auth')process.exit(0);if(a[0]==='repo'){console.log('o/r');process.exit(0)}
if(a[1]==='list'){console.log('[{"number":12}]');process.exit(0)}
const c={id:'PRRC_1',body:'\\u0001'.repeat(4000),author:{login:'human'},url:'https://github.com/o/r/pull/12#discussion_r1'};
if(a[0]==='api'){process.stdout.write(${overflow ? "'x'.repeat(8_000_001)" : "JSON.stringify(Array.from({length:30},()=>({id:'PRRT_1',isResolved:false,comments:{nodes:Array(10).fill(c)}})))"},()=>process.exit(0));}else{
console.log(JSON.stringify({...${JSON.stringify(fixture)},reviews:Array(30).fill(c),comments:Array(30).fill(c)}));}
`, { mode: 0o700 });
      if (overflow) await assert.rejects(github(dir, { action: 'review', branch: 'topic' }, command), { detail: 'gh_pr_failed' });
      else {
        const result = await github(dir, { action: 'review', branch: 'topic' }, command);
        assert.equal(result.pr?.comments.length, 30); assert.equal(result.pr?.reviews.length, 30);
        assert.equal(result.pr?.threads.length, 30); assert.equal(result.pr?.threads[29]?.comments[9]?.body.length, 4000);
      }
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
