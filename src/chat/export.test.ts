import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTranscript } from './export.ts';
import type { ChatRow } from '../shared/types.ts';

test('Markdown export includes turn metadata, usage and only image basenames', () => {
  const rows: ChatRow[] = [
    { role: 'user', at: '2026-10-11T12:34:56Z', text: 'Read /private/work/Projects/P', to: 'codex', model: 'm', effort: 'high', request: 'r', images: ['/private/work/Projects/P/.ai/attachments/a.png', 'C:\\work\\b.png'] },
    { role: 'event', at: 'now', text: 'Read /private/work/file.ts', tool: true },
    { role: 'assistant', at: '2026-10-11T12:35:00Z', text: 'Partial', ai: 'codex', request: 'r', ms: 1, error: 'internal', stopped: true, usage: { input: 10, output: 20, cached: 3 } },
    { role: 'assistant', at: 'old', text: 'Old row', ai: 'claude', request: 'old', ms: 1 },
  ];
  const text = formatTranscript('Task', rows, '/private/work');
  assert.ok(text.startsWith('# Task\n\n## 你'));
  assert.match(text, /2026-10-11T\d{2}:\d{2}:56\.000[+-]\d{2}:\d{2}/u);
  assert.match(text, /模型／思考：m \/ high/u);
  assert.match(text, /- a.png\n- b.png/u);
  assert.match(text, /輸入 10／輸出 20／快取 3/u);
  assert.match(text, /（已停止）/u); assert.match(text, /（回覆失敗）/u);
  assert.ok(!text.includes('/private/work'));
  assert.ok(!text.includes('## 工具'));
  assert.ok(text.includes('Old row'));
  const tools = formatTranscript('Task', rows, '/private/work', true);
  assert.match(tools, /## 工具/u);
  assert.match(tools, /Read \[工作區\]\/file.ts/u);
});

test('Markdown export puts the steps and non-empty task record sections before the conversation, masking the workspace path', () => {
  const rows: ChatRow[] = [{ role: 'user', at: 'now', text: 'Go', to: 'codex', request: 'r' }];
  const sections = { done: ['- edited /private/work/a.ts'], next: [], cautions: ['- keep API'], memo: [] };
  const text = formatTranscript('Task', rows, '/private/work', false, { steps: [{ text: 'Plan', done: true }, { text: 'Ship', done: false }], sections });
  assert.ok(text.startsWith('# Task\n\n## 作業紀錄\n\n### 步驟\n\n- [x] Plan\n- [ ] Ship\n\n### 做了什麼\n\n- edited [工作區]/a.ts\n\n### 注意\n\n- keep API\n\n## 你'));
  assert.ok(!text.includes('### 下一步'));
  const empty = formatTranscript('Task', rows, '/private/work', false, { steps: [], sections: { done: [], next: [], cautions: [], memo: [] } });
  assert.ok(empty.startsWith('# Task\n\n## 你'));
});

test('a reply cut off inside a code block does not turn the rest of the export into code', () => {
  const fences = (markdown: string) => markdown.split('\n').filter(line => /^ {0,3}(`{3,}|~{3,})/u.test(line));
  const rows: ChatRow[] = [
    { role: 'assistant', at: 'now', text: 'Here:\n```ts\nconst a = 1;', ai: 'codex', request: 'r1', ms: 1, stopped: true },
    { role: 'user', at: 'now', text: 'Show a longer fence:\n````md\n```inner\n```', to: 'codex', request: 'r2' },
    { role: 'assistant', at: 'now', text: 'Closed:\n~~~\ncode\n~~~\nand inline ``` ticks', ai: 'codex', request: 'r2', ms: 1 },
    { role: 'user', at: 'now', text: 'Next turn', to: 'codex', request: 'r3' },
  ];
  const text = formatTranscript('Task', rows, '/private/work');
  // Every turn heading sits outside any code block: the fences before it pair up.
  for (const [index] of [...text.matchAll(/^## (你|AI)$/gmu)].map(match => [match.index])) assert.equal(fences(text.slice(0, index)).length % 2, 0);
  assert.match(text, /const a = 1;\n```\n\n（已停止）/u);
  assert.match(text, /```inner\n```\n````\n\n## AI/u, 'a shorter fence inside a longer one does not close it');
  assert.match(text, /and inline ``` ticks\n\n## 你/u, 'balanced fences are left untouched');
});

test('Markdown export masks the home folder after the workspace, only as a whole path segment', () => {
  const rows: ChatRow[] = [{ role: 'user', at: 'now', text: 'See /Users/al/work/Projects/P/a.ts, /Users/al/Code/x.ts and (/Users/al). Not /Users/alice/y.ts', to: 'codex', request: 'r' }];
  const text = formatTranscript('Task in /Users/al/Code', rows, '/Users/al/work', false, undefined, '/Users/al');
  assert.match(text, /^# Task in ~\/Code\n/u);
  assert.match(text, /See \[工作區\]\/Projects\/P\/a\.ts, ~\/Code\/x\.ts and \(~\)\. Not \/Users\/alice\/y\.ts/u);
});
