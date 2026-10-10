import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAsk } from './ask.ts';

test('closed question extracts options and preserves surrounding text', () => {
  assert.deepEqual(parseAsk('before\n[[question]]\nWhich?（可複選）\n1. A\n2. B\n[[/question]]\nafter'), {
    text: 'before\n\nafter',
    asks: [{ question: 'Which?（可複選）', options: ['A', 'B'], multi: true }],
  });
});

test('unclosed or mismatched question blocks remain plain text', () => {
  for (const text of ['[[question]]\nWhich?\n1. A\nrest', '[[question]]Q[[/問題]]']) {
    assert.deepEqual(parseAsk(text), { text, asks: [] });
  }
});

test('text after options remains visible and all options are retained', () => {
  const options = Array.from({ length: 10 }, (_, i) => `option ${i}`);
  const body = options.map((option, i) => `${i + 1}. ${option}`).join('\n');
  const parsed = parseAsk(`[[question]]\nWhich?\n${body}\nImportant explanation\n[[/question]]`);
  assert.equal(parsed.text, 'Important explanation');
  assert.deepEqual(parsed.asks[0]?.options, options);
});

test('empty question stays visible; aliases and multiple blocks are parsed', () => {
  const empty = '[[question]]\n1. A\n[[/question]]';
  assert.deepEqual(parseAsk(empty), { text: empty, asks: [] });
  assert.deepEqual(parseAsk('[[質問]]Q1\n- A[[/質問]]\n[[問題]]Q2\n• B[[/問題]]').asks, [
    { question: 'Q1', options: ['A'], multi: false },
    { question: 'Q2', options: ['B'], multi: false },
  ]);
});
