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
