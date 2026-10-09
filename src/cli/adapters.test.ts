// 以實測抓到的 CLI 輸出（2026-10-10：claude 2.1.294、codex 0.160.1）當 fixture，驗證解析器與引數組裝。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { claudeArgs, createClaudeParser } from './claude.ts';
import { codexArgs, createCodexParser } from './codex.ts';
import type { CliEvent } from './provider.ts';

const SID = 'a1224e07-3f81-4d3b-b53c-db386228e920';
const CLAUDE_LINES: Record<string, unknown>[] = [
  { type: 'system', subtype: 'hook_started', session_id: SID },
  { type: 'system', subtype: 'init', cwd: '/x', session_id: SID, tools: ['Bash'] },
  { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PO' } }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NG' } }, session_id: SID },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Write', id: 't1' } }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 }, session_id: SID },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: SID },
  { type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: SID, num_turns: 1 },
];

function collect(parser: (on: (ev: CliEvent) => void) => (obj: Record<string, unknown>) => void, lines: Record<string, unknown>[]): CliEvent[] {
  const events: CliEvent[] = [];
  const feed = parser((ev) => events.push(ev));
  for (const l of lines) feed(l);
  return events;
}

test('claude：session 只發一次、逐字 delta、assistant 整段不重複、tool_use 註記、result 用串流累積', () => {
  const events = collect(createClaudeParser, CLAUDE_LINES);
  assert.deepEqual(events.filter((e) => e.type === 'session'), [{ type: 'session', id: SID }]);
  assert.deepEqual(
    events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text),
    ['PO', 'NG', '\n⚙ Write\n'],
  );
  assert.deepEqual(events.at(-1), { type: 'result', text: 'PONG\n⚙ Write' });
});

test('claude：沒有 --include-partial-messages 時以 assistant 整段當 delta；is_error 回 error', () => {
  const noStream = CLAUDE_LINES.filter((l) => l['type'] !== 'stream_event');
  const events = collect(createClaudeParser, noStream);
  assert.deepEqual(events.filter((e) => e.type === 'delta'), [{ type: 'delta', text: 'PONG' }]);
  const errored = collect(createClaudeParser, [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: SID }]);
  assert.equal(errored.at(-1)?.type, 'error');
  assert.ok(!errored.some((e) => e.type === 'result'));
});

const TID = '01a121b2-2892-7c91-aae5-21568eb7ca57';
const CODEX_LINES: Record<string, unknown>[] = [
  { type: 'thread.started', thread_id: TID },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: "/bin/zsh -lc 'echo hi'", status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: "/bin/zsh -lc 'echo hi'", exit_code: 0 } },
  { type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: '(hidden)' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'PONG' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
];

test('codex：thread.started → session、command 於 started 時註記一次、reasoning 略過、turn.completed → result', () => {
  const events = collect(createCodexParser, CODEX_LINES);
  assert.deepEqual(events[0], { type: 'session', id: TID });
  assert.deepEqual(
    events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text),
    ["\n⚙ /bin/zsh -lc 'echo hi'\n", 'PONG'],
  );
  assert.deepEqual(events.at(-1), { type: 'result', text: "⚙ /bin/zsh -lc 'echo hi'\nPONG" });
});

test('codex：turn.failed／error 回 error 且不再發 result；多段 agent_message 以空行分隔', () => {
  const failed = collect(createCodexParser, [{ type: 'thread.started', thread_id: TID }, { type: 'turn.failed', error: { message: 'no rollout found' } }, { type: 'turn.completed' }]);
  assert.deepEqual(failed.at(-1), { type: 'error', reason: 'no rollout found' });
  const multi = collect(createCodexParser, [
    { type: 'item.completed', item: { type: 'agent_message', text: 'A' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'B' } },
    { type: 'turn.completed' },
  ]);
  assert.deepEqual(multi.at(-1), { type: 'result', text: 'A\n\nB' });
});

test('引數組裝：model／effort／resume／add-dir／dangerous 依設定與選項', () => {
  const claude = claudeArgs({ ...DEFAULT_CONFIG.cli.claude, dangerous: true }, { prompt: '', cwd: '/w', model: 'haiku', effort: 'low', resumeId: 's1', addDirs: ['/p'] });
  assert.deepEqual(claude.slice(-9), ['--model', 'haiku', '--effort', 'low', '--resume', 's1', '--add-dir', '/p', '--dangerously-skip-permissions']);
  const plain = claudeArgs(DEFAULT_CONFIG.cli.claude, { prompt: '', cwd: '/w' });
  assert.deepEqual(plain, DEFAULT_CONFIG.cli.claude.baseArgs);
  const codex = codexArgs(DEFAULT_CONFIG.cli.codex, { prompt: '', cwd: '/w', model: 'gpt-6-sol', effort: 'high', resumeId: 't1', addDirs: ['/p'] });
  assert.deepEqual(codex.slice(DEFAULT_CONFIG.cli.codex.baseArgs.length), ['-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="high"', '--add-dir', '/p', 'resume', 't1', '-']);
  assert.ok(!codex.includes('--dangerously-bypass-approvals-and-sandbox'));
});
