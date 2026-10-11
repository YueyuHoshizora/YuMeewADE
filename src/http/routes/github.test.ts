import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startTestServer } from '../../testing/server.ts';
import type { Task } from '../../shared/types.ts';

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
