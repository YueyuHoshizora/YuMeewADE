import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeParser } from './claude.ts';
import type { CliEvent } from './provider.ts';

function usageTurn() {
  const events: CliEvent[] = [];
  const feed = createClaudeParser(event => events.push(event));
  const stream = (event: Record<string, unknown>, parent?: string) => feed({
    type: 'stream_event', event, ...(parent ? { parent_tool_use_id: parent } : {}),
  });
  const start = (input: number, creation: number, cached: number, parent?: string) => stream({
    type: 'message_start', message: { usage: {
      input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: cached, output_tokens: 0,
    } },
  }, parent);
  const delta = (output: number, parent?: string) => stream({ type: 'message_delta', usage: { output_tokens: output } }, parent);
  const stop = (parent?: string) => stream({ type: 'message_stop' }, parent);
  const usages = () => events.filter(event => event.type === 'usage').map(event => event.usage);
  return { feed, start, delta, stop, usages, events };
}

test('Claude stopped two-message turn retains completed usage and replaces replayed cumulative deltas', () => {
  const turn = usageTurn();
  turn.start(3, 4, 5);
  turn.delta(6);
  turn.stop();
  turn.start(10, 20, 30);
  turn.delta(39);
  turn.delta(40);
  turn.delta(40);
  // The consumer stops here, before message_stop or a result with aggregate usage.
  assert.deepEqual(turn.usages(), [
    { input: 7, output: 6, cached: 5 },
    { input: 37, output: 45, cached: 35 },
    { input: 37, output: 46, cached: 35 },
    { input: 37, output: 46, cached: 35 },
  ]);
});

test('Claude failed result without usage preserves the measured two-message turn total', () => {
  const turn = usageTurn();
  turn.start(3, 4, 5);
  turn.delta(6);
  turn.stop();
  turn.start(10, 20, 30);
  turn.delta(40);
  turn.stop();
  turn.feed({ type: 'result', subtype: 'error_during_execution', is_error: true });
  assert.deepEqual(turn.usages().at(-1), { input: 37, output: 46, cached: 35 });
  assert.equal(turn.events.at(-1)?.type, 'error');
});

test('Claude interleaved subagent usage is independent and final result usage is authoritative', () => {
  const turn = usageTurn();
  turn.start(3, 4, 5);
  turn.delta(6);
  turn.start(10, 20, 30, 'agent-a');
  turn.delta(40, 'agent-a');
  turn.start(2, 0, 1, 'agent-b');
  turn.delta(3, 'agent-b');
  turn.delta(8);
  turn.stop('agent-a');
  turn.start(1, 0, 0, 'agent-a');
  turn.delta(2, 'agent-a');
  turn.delta(2, 'agent-a');
  assert.deepEqual(turn.usages().at(-1), { input: 40, output: 53, cached: 36 });
  turn.feed({ type: 'result', subtype: 'success', usage: {
    input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 50, output_tokens: 60,
  }, total_cost_usd: 0.25 });
  assert.deepEqual(turn.usages().at(-1), { input: 120, output: 60, cached: 50, claudeUsd: 0.25 });
});
