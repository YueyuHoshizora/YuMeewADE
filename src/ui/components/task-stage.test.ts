import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Busy, TaskView } from '../../shared/types.ts';
import { taskStage } from './task-stage.ts';

const initial: Pick<TaskView, 'question' | 'confirm' | 'state' | 'hasChat'> = { question: '', confirm: false, state: '未開始', hasChat: false };

test('completion claims never obscure an active run or a pending question', () => {
  const claimed = { ...initial, confirm: true, state: '完成' as const };
  assert.equal(taskStage(claimed, {}), 'running');
  assert.equal(taskStage({ ...claimed, question: 'Which behavior?' }, {}), 'attention');
  assert.equal(taskStage(claimed, null), 'review');
});

test('tool approval requires attention before continuing or reviewing', () => {
  const busy: Pick<Busy, 'approvals'> = { approvals: [{ id: 'approval', tool: 'shell', summary: 'npm test', expiresAt: '2026-10-13T00:00:00.000Z' }] };
  assert.equal(taskStage(initial, busy), 'attention');
  assert.equal(taskStage(initial, { approvals: [] }), 'running');
});

test('a resumed or paused task is not mistaken for a fresh brief', () => {
  assert.equal(taskStage(initial, null), 'prepare');
  assert.equal(taskStage({ ...initial, hasChat: true }, null), 'continue');
  assert.equal(taskStage({ ...initial, state: '暫停' }, null), 'continue');
  assert.equal(taskStage({ ...initial, state: '進行中' }, null), 'continue');
  assert.equal(taskStage({ ...initial, state: '完成' }, null), 'review');
});
