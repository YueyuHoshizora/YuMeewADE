import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectView, TaskView } from '../../shared/types.ts';
import { aggregateOverview, type OverviewState } from './overview-logic.ts';

function fixture(tasks: Partial<TaskView>[]): OverviewState {
  return { projects: [{ id: 'p', name: 'Project', currentPhase: 'Build', tasks: tasks.map((task, i) => ({ id: String(i), title: String(i), state: '未開始', question: '', confirm: false, ...task })) } as ProjectView], running: [], unread: [] };
}

test('empty state has zero totals and empty lists', () => {
  const data = aggregateOverview({ projects: [], running: [], unread: [] });
  assert.deepEqual(data.totals, { 未開始: 0, 進行中: 0, 等待回覆: 0, 暫停: 0, 完成: 0 });
  for (const key of ['tasks', 'overdue', 'upcoming', 'waiting', 'running', 'unread', 'projects', 'tags'] as const) assert.deepEqual(data[key], []);
});

test('overdue changes at local midnight; completed tasks excluded from deadlines', () => {
  const state = fixture([{ due: '2026-10-11' }, { due: '2026-10-12' }, { due: '2026-10-11', state: '完成' }]);
  assert.equal(aggregateOverview(state, '', new Date(2026, 9, 11, 23, 59, 59, 999)).overdue.length, 0);
  const data = aggregateOverview(state, '', new Date(2026, 9, 12, 0, 0));
  assert.deepEqual(data.overdue.map(item => item.task.id), ['0']);
  assert.deepEqual(data.upcoming.map(item => item.task.id), ['1']);
  assert.equal(data.totals.完成, 1);
});

test('calendar window includes today and day seven, excludes day eight and empty dates', () => {
  const data = aggregateOverview(fixture([{ due: '2026-03-08' }, { due: '2026-03-15' }, { due: '2026-03-16' }, {}, { due: '2026-03-09', state: '完成' }]), '', new Date(2026, 2, 8, 23));
  assert.deepEqual(data.upcoming.map(item => item.task.id), ['0', '1']);
});

test('attention answers and confirmations, running and unread respect tags and archive removal', () => {
  const state = fixture([{ state: '等待回覆', tags: ['bug'] }, { confirm: true, tags: ['bug'] }, { question: 'Question', tags: ['other'] }, { state: '完成', question: 'Old', tags: ['bug'] }]);
  state.running = [{ project: 'p', task: '0' }, { project: 'archived', task: '0' }] as OverviewState['running'];
  state.unread = [{ project: 'p', task: '3' }, { project: 'p', task: '3' }, { project: 'p', task: 'removed' }, { project: 'archived', task: '0' }];
  const data = aggregateOverview(state, 'bug');
  assert.deepEqual(data.waiting.map(item => item.task.id), ['0', '1']);
  assert.deepEqual(data.running.map(item => item.task.id), ['0']);
  assert.deepEqual(data.unread.map(item => item.task.id), ['3']);
  assert.deepEqual(data.tags, ['bug', 'other']);
  assert.equal(data.projects[0]?.done, 1); assert.equal(data.projects[0]?.total, 3);
  assert.equal(data.projects[0]?.project.currentPhase, 'Build');
  assert.equal(aggregateOverview(state).waiting.length, 3);
  assert.deepEqual(aggregateOverview(state, 'missing').projects, []);
  assert.equal(aggregateOverview(state, 'missing').tasks.length, 0);
});
