import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../../shared/types.ts';
import { selectTasks, taskSelection } from './task-board-model.ts';

const base: Task = { id: 'a', title: 'Alpha', state: '未開始', phase: '', role: '', parent: '', kind: 'main', derivedFrom: '', workspace: 'direct', cli: 'mock', model: '', effort: '', question: '', workdir: '', mergeExcluded: false, updated: '2026-10-01T00:00:00Z', steps: [], memo: '', next: '' };
const tasks: Task[] = [
  { ...base, tags: ['urgent'], due: '2026-10-11' },
  { ...base, id: 'b', title: 'Beta', state: '完成', updated: '2026-10-03T00:00:00Z', due: '2026-10-10', cli: 'codex', tags: ['urgent'] },
  { ...base, id: 'c', title: 'Gamma', state: '進行中', updated: '2026-10-02T00:00:00Z', due: '2026-10-12', tags: ['later'] },
  { ...base, id: 'd', title: 'Delta', updated: '2026-10-02T00:00:00Z' },
];
test('sorts deterministically without mutating input; missing due is last', () => {
  const expected = { updated: ['b', 'c', 'd', 'a'], due: ['b', 'a', 'c', 'd'], title: ['a', 'b', 'd', 'c'], state: ['a', 'd', 'c', 'b'] };
  for (const sort of ['updated', 'due', 'title', 'state'] as const) assert.deepEqual(selectTasks(tasks, taskSelection({ sort })).map(task => task.id), expected[sort]);
  assert.deepEqual(tasks.map(task => task.id), ['a', 'b', 'c', 'd']);
});
test('combines tag, state, AI, overdue and case-insensitive text filters', () => {
  assert.deepEqual(selectTasks(tasks, taskSelection({ tag: 'urgent', state: '未開始', ai: 'mock', overdue: true, text: ' ALP ' }), '2026-10-12').map(task => task.id), ['a']);
  assert.deepEqual(selectTasks(tasks, taskSelection({ overdue: true }), '2026-10-12').map(task => task.id), ['a']);
  assert.deepEqual(selectTasks(tasks, taskSelection({ text: 'URGENT' })).map(task => task.id), ['b', 'a']);
  for (const selection of [{ tag: 'missing' }, { ai: 'claude' }, { state: '暫停' }, { text: 'missing' }]) assert.deepEqual(selectTasks(tasks, taskSelection(selection)), []);
});
test('restores only valid preferences and bounds text; empty input works', () => {
  const defaults = taskSelection(null);
  assert.deepEqual(taskSelection({ view: 'bad', sort: 'bad', state: 'bad', text: 42, overdue: 'yes' }), defaults);
  assert.equal(taskSelection({ text: 'x'.repeat(500) }).text.length, 200);
  assert.deepEqual(selectTasks([], defaults), []);
  assert.equal(taskSelection({ view: 'board', sort: 'due', state: '完成' }).view, 'board');
});
