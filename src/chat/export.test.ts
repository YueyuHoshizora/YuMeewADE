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
