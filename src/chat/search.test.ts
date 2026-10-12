import assert from 'node:assert/strict';
import { test } from 'node:test';
import { search, type SearchReaders } from './search.ts';
import { AppError } from '../shared/errors.ts';
import type { ChatRow, Task } from '../shared/types.ts';
import { startTestServer } from '../testing/server.ts';

function user(text: string, at = 'now'): ChatRow {
  return { role: 'user', text, at, to: 'mock', request: 'request' };
}

function readers(rows: ChatRow[], title = 'Work'): SearchReaders {
  return {
    projects: async () => [{ id: 'Project' }],
    tasks: async () => [{ id: 'task-1', title }],
    readLog: async () => rows,
  };
}

test('search trims query, matches task IDs/titles and chat case-insensitively, preserves row indices and newest-first order', async () => {
  const result = await search(readers([
    user('first NEEDLE', 'first'),
    { role: 'event', text: 'needle hidden tool', at: 'tool', tool: true },
    { role: 'assistant', text: 'last Needle', at: 'last', ai: 'mock', ms: 1, request: 'request' },
  ], 'Needle title'), '  nEeDlE  ');
  assert.deepEqual(result.hits.map(hit => [hit.kind, hit.index, hit.role, hit.at]), [
    ['task', undefined, undefined, undefined], ['chat', 2, 'assistant', 'last'], ['chat', 0, 'user', 'first'],
  ]);
  assert.equal(result.truncated, false);
  assert.equal((await search(readers([]), 'TASK-1')).hits[0]?.kind, 'task');
  assert.deepEqual(await search(readers([]), 'missing'), { hits: [], truncated: false });
  assert.equal((await search(readers([{ role: 'event', text: 'only-event', at: 'now' }]), 'only-event')).hits.length, 0);
});

test('snippets include sixty characters on either side, collapse line breaks and mark omitted text', async () => {
  const result = await search(readers([user('x'.repeat(80) + 'Needle\nline\n' + 'y'.repeat(80))]), 'needle');
  assert.equal(result.hits[0]?.snippet, '…' + 'x'.repeat(60) + 'Needle line ' + 'y'.repeat(54) + '…');
  assert.equal((await search(readers([user('Needle\nshort')]), 'needle')).hits[0]?.snippet, 'Needle short');
});

test('search respects project/task reader order and stops once fifty hits are collected', async () => {
  const ordered = await search({
    projects: async () => [{ id: 'Z' }, { id: 'A' }],
    tasks: async () => [{ id: 'second', title: 'needle' }, { id: 'first', title: 'needle' }],
    readLog: async () => [],
  }, 'needle');
  assert.deepEqual(ordered.hits.map(hit => [hit.project, hit.task]), [['Z', 'second'], ['Z', 'first'], ['A', 'second'], ['A', 'first']]);
  const bounded = await search({
    projects: async () => [{ id: 'Project' }, { id: 'Unreachable' }],
    tasks: async (project) => {
      assert.equal(project, 'Project', 'must stop before scanning another project');
      return [{ id: 'task-1', title: 'Work' }, { id: 'unreachable', title: 'Work' }];
    },
    readLog: async (_project, task) => {
      assert.equal(task, 'task-1', 'must stop before reading another log');
      return Array.from({ length: 100 }, (_, index) => user(`needle ${index}`));
    },
  }, 'needle');
  assert.equal(bounded.hits.length, 50);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.hits.map(hit => hit.index), Array.from({ length: 50 }, (_, index) => 99 - index));
});

test('search stops at the scan budget and reports partial results instead of reading every log', async () => {
  const read: string[] = [];
  const result = await search({
    projects: async () => [{ id: 'Project' }],
    tasks: async () => [{ id: 'a', title: 'Work' }, { id: 'b', title: 'Work' }, { id: 'c', title: 'Work' }],
    readLog: async (_project, task) => { read.push(task); return Array.from({ length: 3 }, (_, index) => user(task === 'b' && index === 0 ? 'needle' : `other ${index}`)); },
  }, 'needle', 5);
  // Budget 5: all of "a" (3 rows), then "b" newest-first reaches rows 2 and 1 before stopping, missing row 0.
  assert.deepEqual(result, { hits: [], truncated: false, partial: true });
  assert.deepEqual(read, ['a', 'b']);
});

test('invalid queries use existing field errors before reading any data', async () => {
  const empty: SearchReaders = {
    projects: async () => { throw new Error('invalid query must not scan'); },
    tasks: async () => [], readLog: async () => [],
  };
  for (const query of [undefined, null, 123, '', ' \n ', 'a'.repeat(201)]) {
    await assert.rejects(search(empty, query), (error: unknown) => error instanceof AppError && error.code === 'bad_request' && error.field === 'q');
  }
  assert.equal((await search(readers([user('a'.repeat(200))]), 'a'.repeat(200))).hits.length, 1);
});

test('GET search is registered, validates q, and returns persisted chat row positions', async () => {
  const server = await startTestServer();
  try {
    await server.api('POST', '/api/project/new', { name: 'Project' });
    const task = (await server.api('POST', '/api/task/new', { project: 'Project', title: 'Needle work', workspace: 'direct' })).json as Task;
    await server.app.store.append('Project', task.id, user('needle chat'));
    const response = await server.api('GET', '/api/search?q=NEEDLE');
    assert.equal(response.status, 200);
    assert.ok(response.json && typeof response.json === 'object' && 'hits' in response.json);
    assert.ok(Array.isArray(response.json.hits));
    assert.deepEqual(response.json.hits.map(hit => [hit.kind, hit.index]), [['task', undefined], ['chat', 0]]);
    for (const query of ['', '?q=%20', '?q=' + 'a'.repeat(201)]) {
      const invalid = await server.api('GET', '/api/search' + query);
      assert.equal(invalid.status, 400);
      assert.ok(invalid.json && typeof invalid.json === 'object' && 'field' in invalid.json);
      assert.equal(invalid.json.field, 'q');
    }
  } finally { await server.close(); }
});
