import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRow } from '../shared/types.ts';
import { buildHandoff, HANDOFF_NOTICE } from './prompt.ts';

const row = (role: ChatRow['role'], text: string, extra: Partial<ChatRow> = {}): ChatRow => ({ at: 't', role, text, cli: 'claude', request: 'r', ...extra });

test('交接包只含人與 AI 的文字，排除 error 列與空白', () => {
  const h = buildHandoff([row('user', '做 A'), row('error', '壞了'), row('assistant', '做好了', { cli: 'codex' }), row('assistant', '   ')], 10_000);
  assert.ok(h.startsWith('<previous_conversation>\n' + HANDOFF_NOTICE));
  assert.match(h, /\[人\]\n做 A/);
  assert.match(h, /\[AI codex\]\n做好了/);
  assert.doesNotMatch(h, /壞了/);
  assert.ok(h.endsWith('</previous_conversation>'));
  assert.equal(buildHandoff([row('error', 'x')], 1000), '');
});

test('超過上限時截舊留新', () => {
  const rows = Array.from({ length: 50 }, (_, i) => row('user', `第${i}句`.padEnd(100, '。')));
  const h = buildHandoff(rows, 1500);
  assert.ok(h.length <= 1500);
  assert.match(h, /更早的對話已截去/);
  assert.match(h, /第49句/);
  assert.doesNotMatch(h, /第0句/);
  // 單筆就超限：留尾段
  const one = buildHandoff([row('assistant', 'x'.repeat(5000) + 'END')], 300);
  assert.ok(one.length <= 320);
  assert.match(one, /END\n<\/previous_conversation>$/);
});
