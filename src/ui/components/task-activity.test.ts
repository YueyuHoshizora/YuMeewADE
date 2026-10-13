import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Busy, ChatRow, TaskView } from '../../shared/types.ts';
import { taskActivity } from './task-activity.ts';

const initial: Pick<TaskView, 'question' | 'state' | 'confirm'> = { question: '', state: '未開始', confirm: false };

test('live execution and questions take precedence over recorded completion', () => {
  const completed = { ...initial, state: '完成' as const };
  assert.equal(taskActivity(completed, {}), 'running');
  assert.equal(taskActivity({ ...completed, question: 'Which behavior?' }, {}), 'waiting');
  assert.equal(taskActivity(completed, null), 'completed');
  assert.equal(taskActivity({ ...completed, confirm: true }, null), 'idle');
});

test('pending tool approval reports waiting rather than running', () => {
  const busy: Pick<Busy, 'approvals'> = { approvals: [{ id: 'approval', tool: 'shell', summary: 'npm test', expiresAt: '2026-10-13T00:00:00.000Z' }] };
  assert.equal(taskActivity(initial, busy), 'waiting');
  assert.equal(taskActivity(initial, { approvals: [] }), 'running');
});

test('ledger progress without a live run is idle, not inferred activity', () => {
  assert.equal(taskActivity(initial, null), 'idle');
  assert.equal(taskActivity({ ...initial, state: '暫停' }, null), 'idle');
  assert.equal(taskActivity({ ...initial, state: '進行中' }, null), 'idle');
});

test('errors come from actual assistant execution, not unchecked criteria', () => {
  const failed: ChatRow = { role: 'assistant', at: '', ai: 'codex', text: '', ms: 0, request: 'run', error: 'timeout' };
  assert.equal(taskActivity(initial, null, failed), 'error');
  assert.equal(taskActivity(initial, {}, failed), 'running');
  assert.equal(taskActivity(initial, null, { role: 'assistant', at: '', ai: 'codex', text: '', ms: 0, request: 'run', stopped: true }), 'idle');
  assert.equal(taskActivity(initial, null, { role: 'user', at: '', to: 'codex', text: 'Try again', request: 'retry' }), 'idle');
});
