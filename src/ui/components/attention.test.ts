/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attention } from './attention.ts';
import type { TaskView } from '../../shared/types.ts';
const task: Pick<TaskView, 'id' | 'title' | 'state' | 'question'> = { id: 't', title: 'Task', state: '進行中', question: '' };
const ref = { project: 'p', task: 't' };
test('unread running tasks need attention only after finishing', () => {
  const state = { projects: [{ id: 'p', tasks: [task] }], running: [ref], unread: [ref] };
  assert.deepEqual(attention(state), []);
  assert.deepEqual(attention({ ...state, running: [] }), [{ ...ref, title: 'Task', kind: 'done' }]);
  assert.deepEqual(attention({ ...state, running: [], unread: [] }), []);
});
test('questions take priority and completed tasks do not wait for answers', () => {
  const state = { projects: [{ id: 'p', tasks: [{ ...task, question: 'Choose?' }] }], running: [], unread: [ref] };
  assert.equal(attention(state)[0]?.kind, 'answer');
  assert.equal(attention({ ...state, projects: [{ id: 'p', tasks: [{ ...task, state: '等待回覆' }] }] })[0]?.kind, 'answer');
  assert.equal(attention({ ...state, unread: [], projects: [{ id: 'p', tasks: [{ ...task, state: '完成', question: 'Old question' }] }] }).length, 0);
});
