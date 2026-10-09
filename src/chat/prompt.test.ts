import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRow } from '../shared/types.ts';
import { buildHandoff, buildPrompt, HANDOFF_NOTICE } from './prompt.ts';
import { parseAsk } from './ask.ts';
const user = (text: string): ChatRow => ({ at: 't', role: 'user', text, to: 'claude', request: 'r' });
test('handoff excludes tools, keeps newest text within limit', () => {
  const rows: ChatRow[] = [user('old'.repeat(1000)), { at: 't', role: 'event', text: 'secret tool output', tool: true }, { at: 't', role: 'assistant', ai: 'codex', text: 'newest', request: 'r', ms: 1 }];
  const h = buildHandoff(rows, 300);
  assert.match(h, /newest/u); assert.doesNotMatch(h, /secret tool/u); assert.ok(h.includes(HANDOFF_NOTICE)); assert.ok(h.length <= 320);
  assert.match(buildPrompt({ text: 'go' }), /# 這次的指示\ngo/u);
});
test('question aliases, bullets, multi and stripping', () => {
  for (const tag of ['question', '質問', '問題']) {
    const parsed = parseAsk(`看完了\n[[${tag}]]\n要選哪些（可複選）\n1. A（建議）\n- B\n[[/${tag}]]`);
    assert.equal(parsed.text, '看完了'); assert.deepEqual(parsed.asks, [{ question: '要選哪些（可複選）', options: ['A（建議）', 'B'], multi: true }]);
  }
  assert.equal(parseAsk('[[question]]\nPick (multi)\n1) A\n2) B').asks[0]?.multi, true);
});
