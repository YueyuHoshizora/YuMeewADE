import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startTestServer } from '../../testing/server.ts';
import type { Task } from '../../shared/types.ts';
import type { LinkedFeedback } from '../../shared/github.ts';

test('fake gh issues list/search/detail/task persist linkage; trust and bad numbers reject', async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'github-http-')); const oldPath = process.env['PATH'];
  await fs.writeFile(path.join(bin, 'gh'), `#!${process.execPath}\nconst a=process.argv.slice(2); if(a[0]==='auth')process.exit(0); if(a[0]==='repo'){console.log('o/r');process.exit(0)} const issue={number:3,title:'Fix issue',body:'First instruction',url:'https://github.com/o/r/issues/3'}; console.log(JSON.stringify(a[1]==='list'?[issue]:issue));\n`, { mode: 0o700 });
  process.env['PATH'] = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const s = await startTestServer();
  try {
    await s.app.projects.create({ name: 'P' });
    assert.equal((await s.api('GET', '/api/git/issues?project=P&search=bug')).status, 200);
    assert.equal((await s.api('GET', '/api/git/issue?project=P&number=3')).status, 200);
    for (const number of ['0', '-1', 'NaN', '1.2']) assert.equal((await s.api('GET', `/api/git/issue?project=P&number=${number}`)).status, 400);
    const created = await s.api('POST', '/api/git/issue-task', { project: 'P', number: 3, title: 'Edited title' });
    assert.equal(created.status, 200);
    const response = created.json as { task: Task }; const task = response.task;
    assert.equal(task.title, 'Edited title'); assert.equal(task.issue, 3); assert.equal(task.issueUrl, 'https://github.com/o/r/issues/3');
    assert.match(await s.app.tasks.readRaw('P', task.id), /issue: 3/); assert.equal((await s.app.tasks.get('P', task.id)).issue, 3);
    await assert.rejects(s.app.tasks.create('P', { title: 'bad', issue: -1 }));
    const trust = await s.app.trust.view('P'); await s.app.trust.update('P', { state: 'restricted', overrides: {}, revision: trust.revision, confirmed: true });
    for (const endpoint of ['issues', 'issue?number=3', 'pr-review']) assert.equal((await s.api('GET', `/api/git/${endpoint}${endpoint.includes('?') ? '&' : '?'}project=P`)).status, 403);
    assert.equal((await s.api('POST', '/api/git/issue-task', { project: 'P', number: 3, title: 'blocked' })).status, 403);
  } finally { await s.close(); if (oldPath === undefined) delete process.env['PATH']; else process.env['PATH'] = oldPath; await fs.rm(bin, { recursive: true, force: true }); }
});

test('feedback task saves provenance and draft without AI; confirmed remote actions refresh and reject stale revisions', async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'github-feedback-http-')), oldPath = process.env['PATH'];
  const log = path.join(bin, 'calls.jsonl'), state = path.join(bin, 'remote.json');
  await fs.writeFile(state, JSON.stringify({ resolved: false, head: 'a'.repeat(40) }));
  await fs.writeFile(path.join(bin, 'gh'), `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[0]==='auth')process.exit(0);if(a[0]==='repo'){console.log('o/r');process.exit(0)}
if(a[0]!=='api'||a[1]!=='graphql')process.exit(8);
if(a.includes('id=PRRC_1')){console.log(JSON.stringify({id:'PRRC_1',pullRequest:{number:12,url:'https://github.com/o/r/pull/12',repository:{nameWithOwner:'o/r'}}}));process.exit(0)}
if(!a.includes('id=PRRT_1'))process.exit(8);
const q=a.find(v=>v.startsWith('query='));const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
if(q.startsWith('query=query')){console.log(JSON.stringify({id:'PRRT_1',isResolved:s.resolved,path:'a.ts',line:5,pullRequest:{number:12,url:'https://github.com/o/r/pull/12',headRefOid:s.head,repository:{nameWithOwner:'o/r'}},comments:{nodes:[{id:'PRRC_1',body:'Fix boundary',author:{login:'human'},url:'https://github.com/o/r/pull/12#discussion_r1'}]}}));process.exit(0)}
if(q.includes('addPullRequestReviewThreadReply')){console.log('{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"PRRC_2"}}}}');process.exit(0)}
const key=q.includes('unresolveReviewThread')?'unresolveReviewThread':'resolveReviewThread';s.resolved=key==='resolveReviewThread';fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s));console.log(JSON.stringify({data:{[key]:{thread:{id:'PRRT_1',isResolved:s.resolved}}}}));
`, { mode: 0o700 });
  process.env['PATH'] = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const s = await startTestServer();
  try {
    await s.app.projects.create({ name: 'P' });
    const source = { project: 'P', repository: 'o/r', number: 12, threadId: 'PRRT_1', commentId: 'PRRC_1', title: 'Review fix', draft: 'Edited initial draft' };
    assert.equal((await s.api('POST', '/api/git/feedback-task', { ...source, repository: 'other/r' })).status, 409);
    assert.equal((await s.api('POST', '/api/git/feedback-task', { ...source, commentId: 'missing' })).status, 409);
    const created = await s.api('POST', '/api/git/feedback-task', source); assert.equal(created.status, 200);
    const result = created.json as { task: Task; feedback: LinkedFeedback };
    const task = result.task.id; let linked = result.feedback;
    assert.equal(linked.draft, source.draft); assert.equal(linked.path, 'a.ts'); assert.equal(linked.line, 5);
    assert.equal(linked.commentId, 'PRRC_1'); assert.equal(linked.source, 'Fix boundary');
    const stored = JSON.parse(await fs.readFile(path.join(s.app.ws.projectDir('P'), '.ai', 'task-linked-feedback', `${task}.json`), 'utf8')) as typeof linked;
    assert.deepEqual(stored, linked); assert.equal(s.app.runner.isBusy(), false);
    assert.equal((await fs.readFile(log, 'utf8')).includes('query=mutation'), false);
    const ids = { project: 'P', task };
    assert.equal((await s.api('POST', '/api/git/feedback-reply', { ...ids, revision: linked.revision, body: 'Reply' })).status, 400);
    assert.equal((await s.api('POST', '/api/git/feedback-resolve', { ...ids, revision: 'stale', confirmed: true })).status, 409);
    const changedDraft = await s.api('POST', '/api/git/feedback-draft', { ...ids, revision: linked.revision, draft: '' }); assert.equal(changedDraft.status, 200);
    linked = changedDraft.json as typeof linked; assert.equal(linked.draft, '');
    await fs.writeFile(state, JSON.stringify({ resolved: false, head: 'b'.repeat(40) }));
    assert.equal((await s.api('POST', '/api/git/feedback-resolve', { ...ids, revision: linked.revision, confirmed: true })).status, 409);
    linked = (await s.api('POST', '/api/git/feedback-refresh', { ...ids, revision: linked.revision })).json as typeof linked;
    assert.equal(linked.headOid, 'b'.repeat(40));
    const resolved = await s.api('POST', '/api/git/feedback-resolve', { ...ids, revision: linked.revision, confirmed: true }); assert.equal(resolved.status, 200);
    linked = resolved.json as typeof linked; assert.equal(linked.resolved, true);
    const unresolve = await s.api('POST', '/api/git/feedback-unresolve', { ...ids, revision: linked.revision, confirmed: true }); assert.equal(unresolve.status, 200);
    linked = unresolve.json as typeof linked; assert.equal(linked.resolved, false);
    const trust = await s.app.trust.view('P'); await s.app.trust.update('P', { state: 'restricted', overrides: {}, revision: trust.revision, confirmed: true });
    assert.equal((await s.api('POST', '/api/git/feedback-reply', { ...ids, revision: linked.revision, body: 'Blocked', confirmed: true })).status, 403);
    const mutations = (await fs.readFile(log, 'utf8')).trim().split('\n').map(v => JSON.parse(v) as string[]).filter(call => call.some(arg => arg.startsWith('query=mutation')));
    assert.equal(mutations.length, 2);
  } finally { await s.close(); if (oldPath === undefined) delete process.env['PATH']; else process.env['PATH'] = oldPath; await fs.rm(bin, { recursive: true, force: true }); }
});

for (const scenario of ['confirmed reply survives refresh failure', 'issue update rejects external edits until refresh', 'deleted pinned comment rejects reply'] as const) test(scenario, async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'github-stale-http-')), oldPath = process.env['PATH'];
  const state = path.join(bin, 'state.json');
  const initial = { deleted: false, replies: 0, failRefresh: false, issue: { number: 3, title: 'Original', body: 'Original body', state: 'OPEN', url: 'https://github.com/o/r/issues/3', contentVersion: '2026-10-13T00:00:00Z' } };
  await fs.writeFile(state, JSON.stringify(initial));
  await fs.writeFile(path.join(bin, 'gh'), `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),file=${JSON.stringify(state)},s=JSON.parse(fs.readFileSync(file,'utf8'));
if(a[0]==='auth')process.exit(0);if(a[0]==='repo'){console.log('o/r');process.exit(0)}
if(a[0]==='issue'){console.log(JSON.stringify(s.issue));process.exit(0)}
const pr={number:12,url:'https://github.com/o/r/pull/12',headRefOid:'a'.repeat(40),repository:{nameWithOwner:'o/r'}};
if(a[1]==='graphql'){
 const q=a.find(x=>x.startsWith('query='));
 if(q.includes('... on PullRequestReviewComment')){console.log(JSON.stringify(s.deleted?null:{id:'PRRC_1',pullRequest:pr}));process.exit(0)}
 if(q.startsWith('query=query')){
  if(s.failRefresh&&s.replies)process.exit(1);
  console.log(JSON.stringify({id:'PRRT_1',isResolved:false,path:'a.ts',line:1,pullRequest:pr,comments:{nodes:[{id:'PRRC_1',body:'Pinned',author:{login:'human'},url:pr.url+'#discussion_r1'}]}}));process.exit(0)
 }
 s.replies++;fs.writeFileSync(file,JSON.stringify(s));console.log('{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"PRRC_2"}}}}');process.exit(0)
}
for(const x of a){if(x.startsWith('title='))s.issue.title=x.slice(6);if(x.startsWith('body='))s.issue.body=x.slice(5)}
s.issue.contentVersion='2026-10-13T00:00:02Z';fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(s.issue));
`, { mode: 0o700 });
  process.env['PATH'] = `${bin}${path.delimiter}${oldPath ?? ''}`;
  const server = await startTestServer();
  try {
    await server.app.projects.create({ name: 'P' });
    const issueScenario = scenario.startsWith('issue');
    const created = await server.api('POST', issueScenario ? '/api/git/issue-task' : '/api/git/feedback-task', issueScenario ? { project: 'P', number: 3, title: 'Issue' } : { project: 'P', repository: 'o/r', number: 12, threadId: 'PRRT_1', commentId: 'PRRC_1', title: 'Feedback', draft: '' });
    assert.equal(created.status, 200);
    const linked = created.json as { task: Task; feedback: LinkedFeedback };
    const ids = { project: 'P', task: linked.task.id, revision: linked.feedback.revision, confirmed: true };
    const remote = JSON.parse(await fs.readFile(state, 'utf8')) as typeof initial;
    if (issueScenario) {
      remote.issue.title = 'External title'; remote.issue.body = 'External body'; remote.issue.contentVersion = '2026-10-13T00:00:01Z';
      await fs.writeFile(state, JSON.stringify(remote));
      const update = { ...ids, title: 'My title', body: 'My body' };
      assert.equal((await server.api('POST', '/api/git/feedback-update', update)).status, 409);
      assert.equal(linked.feedback.contentVersion, initial.issue.contentVersion);
      assert.deepEqual((JSON.parse(await fs.readFile(state, 'utf8')) as typeof initial).issue, remote.issue);
      const refreshed = await server.api('POST', '/api/git/feedback-refresh', ids);
      assert.equal(refreshed.status, 200);
      assert.equal((refreshed.json as LinkedFeedback).contentVersion, remote.issue.contentVersion);
      const updated = await server.api('POST', '/api/git/feedback-update', { ...update, revision: (refreshed.json as LinkedFeedback).revision });
      assert.equal(updated.status, 200); assert.equal((updated.json as LinkedFeedback).contentVersion, '2026-10-13T00:00:02Z');
      assert.equal((JSON.parse(await fs.readFile(state, 'utf8')) as typeof initial).issue.title, 'My title');
    } else {
      remote.deleted = scenario.startsWith('deleted'); remote.failRefresh = !remote.deleted;
      await fs.writeFile(state, JSON.stringify(remote));
      const reply = await server.api('POST', '/api/git/feedback-reply', { ...ids, body: 'Reply' });
      assert.equal(reply.status, remote.deleted ? 409 : 200);
      if (!remote.deleted) {
        assert.notEqual((reply.json as LinkedFeedback).revision, ids.revision);
        assert.equal((await server.api('POST', '/api/git/feedback-reply', { ...ids, body: 'Reply' })).status, 409);
      }
      assert.equal((JSON.parse(await fs.readFile(state, 'utf8')) as typeof initial).replies, remote.deleted ? 0 : 1);
    }
  } finally { await server.close(); if (oldPath === undefined) delete process.env['PATH']; else process.env['PATH'] = oldPath; await fs.rm(bin, { recursive: true, force: true }); }
});
