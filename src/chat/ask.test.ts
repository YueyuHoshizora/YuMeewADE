import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAsk } from './ask.ts';

test('closed question extracts options and preserves surrounding text', () => {
  assert.deepEqual(parseAsk('before\n[[question]]\nWhich?（可複選）\n1. A\n2. B\n[[/question]]\nafter'), {
    text: 'before\n\nafter',
    asks: [{ question: 'Which?（可複選）', options: ['A', 'B'], multi: true }],
  });
});

test('unclosed question consumes only its options and keeps later prose visible', () => {
  for (const separator of ['\n', '\n\n']) {
    assert.deepEqual(parseAsk(`[[question]]\nWhich?\n1. A\n2. B${separator}rest\n- unrelated list`), {
      text: 'rest\n- unrelated list',
      asks: [{ question: 'Which?', options: ['A', 'B'], multi: false }],
    });
  }
  assert.deepEqual(parseAsk('[[question]]\nPick (multi)\n1) A\n2) B'), {
    text: '',
    asks: [{ question: 'Pick (multi)', options: ['A', 'B'], multi: true }],
  });
});

test('unclosed question without options ends at its first paragraph', () => {
  assert.deepEqual(parseAsk('before\n[[question]]\nQuestion line\nmore question\n\nVisible paragraph\n1. not an option'), {
    text: 'before\n\n\nVisible paragraph\n1. not an option',
    asks: [{ question: 'Question line\nmore question', options: [], multi: false }],
  });
  const mismatched = '[[question]]Q[[/問題]]';
  assert.deepEqual(parseAsk(mismatched), { text: mismatched, asks: [] });
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

test('question tags quoted in fenced or inline code stay visible and are not asked', () => {
  for (const fence of ['```', '~~~~']) {
    const sample = `Syntax:\n${fence}text\n[[question]]\nWhich database?\n1. SQLite\n${fence}\nDone.`;
    assert.deepEqual(parseAsk(sample), { text: sample, asks: [] });
  }
  const inline = 'Wrap it in `[[question]]` and `[[/question]]`.\nNothing else.';
  assert.deepEqual(parseAsk(inline), { text: inline, asks: [] });
  // An empty block closes too, so the real question after it is still asked; code inside a question stays verbatim.
  const parsed = parseAsk('```\n```\n[[question]]\nRun `npm test`?\n1. Yes `now`\n[[/question]]');
  assert.deepEqual(parsed, { text: '```\n```', asks: [{ question: 'Run `npm test`?', options: ['Yes `now`'], multi: false }] });
});

test('question tags in list-indented fences stay byte-for-byte content while questions outside remain live', () => {
  for (const indent of ['    ', '        ', '\t']) {
    for (const fence of ['```', '~~~~']) {
      for (const newline of ['\n', '\r\n']) {
        const other = fence[0] === '`' ? '~~~' : '```';
        const sample = [
          '- Example question syntax:', '', `${indent}${fence}text`,
          `${indent}[[question]]`, `${indent}Which database?`, `${indent}1. SQLite`,
          `${indent}${other}`, `${indent}${fence.slice(1)}`, `${indent}[[/question]]`,
          `${indent}${fence}${fence[0]}`, 'Done.',
        ].join(newline);
        assert.deepEqual(parseAsk(sample), { text: sample, asks: [] });
        assert.deepEqual(parseAsk(`${sample}\n[[question]]\nReal question?\n1. Yes\n[[/question]]`), {
          text: sample, asks: [{ question: 'Real question?', options: ['Yes'], multi: false }],
        });
      }
    }
  }
});
