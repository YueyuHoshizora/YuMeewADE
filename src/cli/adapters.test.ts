// 以實測抓到的 CLI 輸出（2026-10-10：claude 2.1.294、codex 0.160.1）當 fixture，驗證解析器與引數組裝。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { ClaudeCliProvider, claudeArgs, claudeExtraUsage, claudeOauthQuota, claudeQuota, claudeResetCredits, createClaudeParser, fetchClaudeQuota } from './claude.ts';
import { CodexCliProvider, codexAppServerQuota, codexArgs, codexExtraUsage, codexQuota, createCodexParser, fetchCodexQuota, readCodexQuota } from './codex.ts';
import { captureCommand, redactArgs } from './process.ts';
import { MockCliProvider } from './mock.ts';
import type { CliEvent } from './provider.ts';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SID = 'a1224e07-3f81-4d3b-b53c-db386228e920';
const CLAUDE_LINES: Record<string, unknown>[] = [
  { type: 'system', subtype: 'hook_started', session_id: SID },
  { type: 'system', subtype: 'init', cwd: '/x', session_id: SID, tools: ['Bash'] },
  { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PO' } }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NG' } }, session_id: SID },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Write', id: 't1', input: {} } }, session_id: SID },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 }, session_id: SID },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: 't1', input: { file_path: '/x/result.ts', content: 'export {}' } }] }, session_id: SID },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: SID },
  { type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: SID, num_turns: 1 },
];

function collect(parser: (on: (ev: CliEvent) => void) => (obj: Record<string, unknown>) => void, lines: Record<string, unknown>[]): CliEvent[] {
  const events: CliEvent[] = [];
  const feed = parser((ev) => events.push(ev));
  for (const l of lines) feed(l);
  return events;
}

test('claude：session 只發一次、逐字 delta、assistant 不重複、tool 獨立於回答', () => {
  const events = collect(createClaudeParser, CLAUDE_LINES);
  assert.deepEqual(events.filter((e) => e.type === 'session'), [{ type: 'session', id: SID }]);
  assert.deepEqual(
    events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text),
    ['PO', 'NG'],
  );
  assert.deepEqual(events.filter((e) => e.type === 'tool'), [{ type: 'tool', text: 'Write: /x/result.ts' }]);
  assert.deepEqual(events.at(-1), { type: 'result', text: 'PONG' });
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
    ['PONG'],
  );
  assert.deepEqual(events.filter((e) => e.type === 'tool'), [{ type: 'tool', text: "command: /bin/zsh -lc 'echo hi'" }]);
  assert.deepEqual(events.at(-1), { type: 'result', text: 'PONG' });
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

test('引數組裝：每輪 fullAccess、圖片、resume 和 stdin marker', () => {
  const claude = claudeArgs(DEFAULT_CONFIG.cli.claude, { prompt: '', cwd: '/w', model: 'haiku', effort: 'low', resumeId: 's1', addDirs: ['/p'], fullAccess: true });
  assert.deepEqual(claude, ['--dangerously-skip-permissions', ...DEFAULT_CONFIG.cli.claude.baseArgs, '--model', 'haiku', '--effort', 'low', '--resume', 's1', '--add-dir', '/p']);
  const plain = claudeArgs(DEFAULT_CONFIG.cli.claude, { prompt: '', cwd: '/w', fullAccess: false });
  assert.deepEqual(plain, [...DEFAULT_CONFIG.cli.claude.safeArgs, ...DEFAULT_CONFIG.cli.claude.baseArgs]);
  const codex = codexArgs(DEFAULT_CONFIG.cli.codex, { prompt: '', cwd: '/w', model: 'gpt-6-sol', effort: 'high', resumeId: 't1', images: ['/p.png', '/q.png'], fullAccess: false });
  assert.deepEqual(codex, ['exec', ...DEFAULT_CONFIG.cli.codex.safeArgs, '--json', '--skip-git-repo-check', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="high"', '-i', '/p.png', '-i', '/q.png', 'resume', 't1', '-']);
  assert.ok(!codex.includes('--dangerously-bypass-approvals-and-sandbox'));
  const fresh = codexArgs(DEFAULT_CONFIG.cli.codex, { prompt: '', cwd: '/w' });
  assert.equal(fresh.at(-1), '-');
  assert.ok(fresh.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('redactArgs：帶值旗標的值不進日誌', () => {
  assert.deepEqual(redactArgs(['-p', '--resume', 'sid-123', '--add-dir', '/Users/me/secret', '-c', 'x=1', '--verbose']), ['-p', '--resume', '<…>', '--add-dir', '<…>', '-c', '<…>', '--verbose']);
});

test('claude：串流後仍解析 AskUserQuestion，工具 id 去重', () => {
  const tool = { type: 'tool_use', name: 'AskUserQuestion', id: 'ask1', input: { questions: [{ question: '選哪個？', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] } };
  const events = collect(createClaudeParser, [
    ...CLAUDE_LINES.slice(0, 18),
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'AskUserQuestion', id: 'ask1', input: {} } } },
    { type: 'assistant', message: { content: [tool] } },
    { type: 'assistant', message: { content: [tool] } },
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'asks'), [{ type: 'asks', asks: [{ question: '選哪個？', options: ['A', 'B'], multi: true }] }]);
  assert.deepEqual(events.filter((e) => e.type === 'tool'), [{ type: 'tool', text: 'Write: /x/result.ts' }]);
});

test('claude：工具摘要只從完整 assistant 發出，忽略部分輸入並去重', () => {
  const cases = [
    { name: 'Read', input: { file_path: '/x/read.ts' }, text: 'Read: /x/read.ts' },
    { name: 'Edit', input: { file_path: '/x/edit.ts' }, text: 'Edit: /x/edit.ts' },
    { name: 'Write', input: { file_path: '/x/write.ts' }, text: 'Write: /x/write.ts' },
    { name: 'Bash', input: { command: 'x'.repeat(200) }, text: `Bash: ${'x'.repeat(160)}` },
    { name: 'Grep', input: { pattern: 'find me' }, text: 'Grep: find me' },
    { name: 'Glob', input: { pattern: '**/*.ts' }, text: 'Glob: **/*.ts' },
    { name: 'Custom', input: { command: 'ignored' }, text: 'Custom' },
  ];
  for (const fixture of cases) {
    const events: CliEvent[] = [];
    const feed = createClaudeParser(ev => events.push(ev));
    feed({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool1', name: fixture.name, input: {} } } });
    feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file_path":' } } });
    assert.deepEqual(events.filter(ev => ev.type !== 'tokens'), []);
    const complete = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: fixture.name, input: fixture.input }] } };
    feed(complete); feed(complete);
    assert.deepEqual(events.filter(ev => ev.type !== 'tokens'), [{ type: 'tool', text: fixture.text }]);
  }
});

test('claude：下一個 message 的非串流文字不會被先前串流吞掉', () => {
  const events = collect(createClaudeParser, [
    ...CLAUDE_LINES.slice(0, 18),
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: ' NEXT' }] } },
    { type: 'result', subtype: 'success' },
  ]);
  assert.deepEqual(events.at(-1), { type: 'result', text: 'PONG NEXT' });
});

test('codex：僅 completed 的指令、file_change 和舊版 msg', () => {
  const events = collect(createCodexParser, [
    { type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } },
    { msg: { type: 'session_configured', session_id: 'old' } },
    { msg: { type: 'exec_command_begin', command: ['echo', 'hi'] } },
    { msg: { type: 'agent_message', message: 'legacy' } },
    { msg: { type: 'task_complete' } },
  ]);
  assert.deepEqual(events, [
    { type: 'tool', text: 'command: pwd' },
    { type: 'tool', text: 'file_change: a.ts, b.ts' },
    { type: 'session', id: 'old' },
    { type: 'tool', text: 'command: echo hi' },
    { type: 'delta', text: 'legacy' },
    { type: 'result', text: 'legacy' },
  ]);
  const failed = collect(createCodexParser, [{ msg: { type: 'error', message: 'boom' } }, { msg: { type: 'task_complete' } }]);
  assert.deepEqual(failed, [{ type: 'error', reason: 'boom' }]);
});

test('Mock：可設定文字、工具、問題；數字建構子與延遲停止', async () => {
  const events: CliEvent[] = [];
  const provider = new MockCliProvider({ chunkMs: 0, text: 'hello', events: [{ type: 'tool', text: 'Read' }, { type: 'asks', asks: [{ question: 'Q?', options: ['A', 'B'], multi: false }] }] });
  const run = provider.send({ prompt: '', cwd: '/w' }, (ev) => events.push(ev));
  assert.deepEqual(await run.done, { ok: true, stopped: false });
  assert.deepEqual(events.at(-1), { type: 'result', text: 'hello' });
  assert.ok(events.some((ev) => ev.type === 'tool'));
  assert.ok(events.some((ev) => ev.type === 'asks'));
  const slow = new MockCliProvider({ chunkMs: 100, stopMs: 20 }).send({ prompt: '[slow]', cwd: '/w' }, () => undefined);
  slow.stop();
  assert.deepEqual(await slow.done, { ok: false, stopped: true });
  const numeric = new MockCliProvider(0).send({ prompt: 'test', cwd: '/w' }, () => undefined);
  assert.equal((await numeric.done).ok, true);
});

test('captureCommand：捕捉輸出、退出失敗與 timeout', async () => {
  const result = await captureCommand({ command: process.execPath, args: ['-e', 'process.stdout.write(\"1.2.3\");process.stderr.write(\"note\")'], timeoutMs: 1000 });
  assert.deepEqual(result, { ok: true, stdout: '1.2.3', stderr: 'note' });
  const failed = await captureCommand({ command: process.execPath, args: ['-e', 'process.exit(7)'], timeoutMs: 1000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'exit 7');
  // 子行程不共用測試的 fake clock；此 integration case 故意使用真正的 timeout。
  const timed = await captureCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 30 });
  assert.equal(timed.reason, 'command timeout');
});

test('CLI 零退出但沒有最終結果時失敗，保留部分文字', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-result-'));
  try {
    for (const ai of ['claude', 'codex'] as const) {
      const partial = ai === 'claude'
        ? { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }
        : { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } };
      const terminal = ai === 'claude'
        ? { type: 'result', subtype: 'success', result: 'partial' }
        : { type: 'turn.completed' };
      for (const lines of [[], ['not json'], [JSON.stringify(partial)], [JSON.stringify(partial), JSON.stringify(terminal)]]) {
        const script = path.join(dir, 'fake.ts');
        await fs.writeFile(script, `process.stdin.resume(); process.stdin.on('end', () => { console.log(${JSON.stringify(lines.join('\n'))}); });`);
        const cfg = {
          ...DEFAULT_CONFIG.cli[ai], command: process.execPath,
          baseArgs: [script], fullAccessArgs: [], safeArgs: [],
        };
        const provider = ai === 'claude'
          ? new ClaudeCliProvider(cfg, []) : new CodexCliProvider(cfg, []);
        const events: CliEvent[] = [];
        const outcome = await provider.send({ prompt: 'go', cwd: dir }, ev => events.push(ev)).done;
        assert.equal(outcome.ok, lines.length === 2);
        if (lines.length < 2) {
          assert.equal(outcome.reason, 'no result event');
          assert.deepEqual(events.at(-1), { type: 'error', reason: 'no result event' });
        }
        if (lines.includes(JSON.stringify(partial))) {
          assert.deepEqual(events.filter(ev => ev.type === 'delta'), [{ type: 'delta', text: 'partial' }]);
        }
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('claude：rate_limit_event 轉成額度窗口，舊版單一窗口與被拒狀態也認得', () => {
  // 2026-10-10 claude 2.1.296 實測格式。
  const events = collect(on => createClaudeParser(on, () => Date.parse('2026-10-10T17:00:00Z')), [{
    type: 'rate_limit_event', session_id: SID,
    rate_limit_info: { status: 'allowed', resetsAt: 1791654000, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.21, resetsAt: 1791654000 }, seven_day: { utilization: 0.034, resetsAt: 1792216800 } } },
  }]);
  assert.deepEqual(events.filter(ev => ev.type === 'quota'), [{
    type: 'quota', limited: false, at: '2026-10-10T17:00:00.000Z',
    windows: [
      { label: '5h', usedPercent: 21, resetsAt: new Date(1791654000 * 1000).toISOString() },
      { label: '7d', usedPercent: 3.4, resetsAt: new Date(1792216800 * 1000).toISOString() },
    ],
  }]);
  assert.deepEqual(claudeQuota({ status: 'rejected', rateLimitType: 'seven_day_opus', utilization: 1.2 }), {
    limited: true, windows: [{ label: '7d opus', usedPercent: 100, resetsAt: null }],
  });
  assert.equal(claudeQuota({ status: 'allowed' }), null);
});

test('claude：只測量實際累計 output_tokens；文字分塊、思考估算與重複回報不加總', () => {
  for (const chunks of [['abcdefgh'], ['a', 'bc', 'defgh']]) {
    let clock = 0;
    const events: CliEvent[] = [];
    const feed = createClaudeParser(ev => events.push(ev), () => clock);
    const event = (value: Record<string, unknown>) => feed({ type: 'stream_event', event: value });
    event({ type: 'message_start', message: { usage: { output_tokens: 1 } } });
    clock = 500;
    event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 9000 } });
    for (const text of chunks) event({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
    assert.equal(events.filter(ev => ev.type === 'tokens').length, 0);
    clock = 2000;
    event({ type: 'message_delta', usage: { output_tokens: 160, thinking_tokens: 100 } });
    clock = 3000;
    event({ type: 'message_delta', usage: { output_tokens: 160 } });
    event({ type: 'message_delta', usage: { output_tokens: NaN } });
    event({ type: 'message_delta', usage: { output_tokens: -1 } });
    clock = 4000;
    event({ type: 'message_delta', usage: { output_tokens: 200 } });
    event({ type: 'message_stop' });
    const tokens = events.filter(ev => ev.type === 'tokens');
    assert.equal(tokens.length, 2);
    assert.deepEqual(tokens.map(({ runId: _, ...sample }) => sample), [
      { type: 'tokens', count: 160, spanMs: 2000, at: 2000 },
      { type: 'tokens', count: 200, spanMs: 4000, at: 4000 },
    ]);
    clock = 5000;
    event({ type: 'message_start' });
    clock = 6000;
    event({ type: 'message_delta', usage: { output_tokens: 20 } });
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 220 } });
    event({ type: 'message_delta', usage: { output_tokens: 300 } });
    assert.equal(events.filter(ev => ev.type === 'tokens').length, 3);
  }
});

test('codex：實際 output_tokens／整回合耗時；無開始、零耗時、失敗與無效計數不估算', () => {
  let clock = 0;
  const events: CliEvent[] = [];
  const feed = createCodexParser(ev => events.push(ev), () => clock);
  feed({ type: 'turn.completed', usage: { output_tokens: 500 } });
  feed({ type: 'turn.started' });
  feed({ type: 'turn.completed', usage: { output_tokens: 500 } });
  feed({ type: 'turn.started' });
  clock = 2000;
  feed({ type: 'item.completed', item: { type: 'reasoning', text: 'not tokens' } });
  feed({ type: 'item.completed', item: { type: 'agent_message', text: 'not tokenized' } });
  feed({ type: 'turn.completed', usage: { output_tokens: 100, reasoning_output_tokens: 40 } });
  clock = 3000;
  feed({ type: 'turn.completed', usage: { output_tokens: 100 } });
  assert.deepEqual(events.filter(ev => ev.type === 'tokens').map(({ runId: _, ...sample }) => sample),
    [{ type: 'tokens', count: 100, spanMs: 2000, at: 2000 }]);
  for (const output of [NaN, Infinity, -1]) {
    feed({ type: 'turn.started' }); clock += 1000;
    feed({ type: 'turn.completed', usage: { output_tokens: output } });
  }
  feed({ type: 'turn.started' }); clock += 1000;
  feed({ type: 'turn.failed', error: { message: 'stopped' } });
  feed({ type: 'turn.completed', usage: { output_tokens: 100 } });
  assert.equal(events.filter(ev => ev.type === 'tokens').length, 1);
});

test('codex：rate_limits 依窗口長度命名、回報已達上限', () => {
  const at = '2026-10-10T16:57:59.661Z';
  assert.deepEqual(codexQuota({
    primary: { used_percent: 1, window_minutes: 300, resets_at: 1791660799 },
    secondary: { used_percent: 75, window_minutes: 10080, resets_at: 1791948855 },
    rate_limit_reached_type: null,
  }, at), {
    type: 'quota', limited: false, at,
    windows: [
      { label: '5h', usedPercent: 1, resetsAt: new Date(1791660799 * 1000).toISOString() },
      { label: '7d', usedPercent: 75, resetsAt: new Date(1791948855 * 1000).toISOString() },
    ],
  });
  assert.equal(codexQuota({ primary: { used_percent: 100, window_minutes: 90 }, rate_limit_reached_type: 'primary' }, at)?.limited, true);
  assert.equal(codexQuota({ primary: null, secondary: null, rate_limit_reached_type: null }, at), null);
});

test('codex：從 rollout 讀額度，指定會話時往舊日期找，最新額度跳過沒有 rate_limits 的事件', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  const tokenCount = (timestamp: string, used: number | null) => JSON.stringify({
    timestamp, type: 'event_msg',
    payload: { type: 'token_count', rate_limits: used === null ? null : { primary: { used_percent: used, window_minutes: 300 }, rate_limit_reached_type: null } },
  });
  const put = async (day: string, name: string, lines: string[]) => {
    await fs.mkdir(path.join(home, 'sessions', day), { recursive: true });
    await fs.writeFile(path.join(home, 'sessions', day, name), lines.join('\n') + '\n');
  };
  try {
    assert.equal(await readCodexQuota(home), null);
    await put('2026/09/30', `rollout-2026-09-30T08-00-00-${TID}.jsonl`, [tokenCount('2026-09-30T08:00:00Z', 10), tokenCount('2026-10-11T09:00:00Z', 40)]);
    await put('2026/10/11', 'rollout-2026-10-11T01-00-00-other.jsonl', [tokenCount('2026-10-11T01:00:00Z', 20), tokenCount('2026-10-11T01:00:05Z', null), '{"broken']);
    // 續聊的舊會話追加在 9/30 的檔；最新日期的檔找不到這個 thread 不能誤用。
    assert.equal((await readCodexQuota(home, TID))?.windows[0]?.usedPercent, 40);
    const latest = await readCodexQuota(home);
    assert.equal(latest?.at, '2026-10-11T01:00:00Z');
    assert.equal(latest?.windows[0]?.usedPercent, 20);
    assert.equal(await readCodexQuota(home, 'missing-thread'), null);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('turn usage is exact, optional, and independent of live tokens', async () => {
  const events = collect(createClaudeParser, [
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5, output_tokens: 0 } } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 6 } } },
    { type: 'result', is_error: true, usage: { input_tokens: 30, cache_creation_input_tokens: 40, cache_read_input_tokens: 50, output_tokens: 60 } },
  ]);
  assert.deepEqual(events.filter(e => e.type === 'usage'), [
    { type: 'usage', usage: { input: 7, output: 6, cached: 5 } },
    { type: 'usage', usage: { input: 70, output: 60, cached: 50 } },
  ]);
  const codex = collect(createCodexParser, [
    ...CODEX_LINES,
    { type: 'turn.completed', usage: { input_tokens: 9, cached_input_tokens: 2, output_tokens: 8 } },
    { type: 'turn.completed', usage: { input_tokens: 'bad', output_tokens: 2 } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: NaN } },
  ]);
  assert.deepEqual(codex.filter(e => e.type === 'usage'), [
    { type: 'usage', usage: { input: 1, output: 1 } },
    { type: 'usage', usage: { input: 9, output: 8, cached: 2 } },
  ]);
  const mockEvents: CliEvent[] = [];
  await new MockCliProvider({ chunkMs: 0, events: [{ type: 'usage', usage: { input: 7, output: 6 } }] })
    .send({ prompt: '', cwd: '/w' }, e => mockEvents.push(e)).done;
  assert.deepEqual(mockEvents.find(e => e.type === 'usage'), { type: 'usage', usage: { input: 7, output: 6 } });
});

test('Codex app-server 額度回應轉成窗口（5h／7d、重置時間、達上限旗標）', () => {
  const snapshot = {
    limitId: 'codex',
    primary: { usedPercent: 86, windowDurationMins: 300, resetsAt: 1791678946 },
    secondary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: 1791948855 },
    rateLimitReachedType: null,
  };
  const quota = codexAppServerQuota({ rateLimits: { limitId: 'x' }, rateLimitsByLimitId: { codex: snapshot } }, 'T');
  assert.deepEqual(quota, {
    type: 'quota', at: 'T', limited: false,
    windows: [
      { label: '5h', usedPercent: 86, resetsAt: new Date(1791678946_000).toISOString() },
      { label: '7d', usedPercent: 90, resetsAt: new Date(1791948855_000).toISOString() },
    ],
  });
  // 沒有分桶時退回舊版單桶；達上限旗標照帶。
  const limited = codexAppServerQuota({ rateLimits: { ...snapshot, rateLimitReachedType: 'primary' }, rateLimitsByLimitId: null }, 'T');
  assert.equal(limited?.limited, true);
  assert.equal(codexAppServerQuota({}, 'T'), null);
});

test('Codex 重置券：只收可用券、依到期日排序，null 到期代表不會到期，格式錯誤整體忽略', () => {
  const snapshot = { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791948586 }, rateLimitReachedType: 'rate_limit_reached' };
  const credit = (status: string, expiresAt: number | null, title: string | null = 'Full reset') => ({ id: 'opaque-id', resetType: 'codexRateLimits', status, grantedAt: 1, expiresAt, title, description: 'x' });
  const quota = codexAppServerQuota({
    rateLimits: snapshot,
    rateLimitResetCredits: { availableCount: 3, credits: [credit('available', 1794007502), credit('redeemed', 1792000000), credit('available', 1792700953), credit('available', null, null)] },
  }, 'T');
  assert.deepEqual(quota?.resetCredits, {
    availableCount: 3,
    credits: [
      { title: 'Full reset', expiresAt: new Date(1792700953_000).toISOString() },
      { title: 'Full reset', expiresAt: new Date(1794007502_000).toISOString() },
      { title: null, expiresAt: null },
    ],
  });
  // 只有張數沒有明細（背景輪詢）：張數照帶，明細為空。
  assert.deepEqual(codexAppServerQuota({ rateLimits: snapshot, rateLimitResetCredits: { availableCount: 2, credits: null } }, 'T')?.resetCredits, { availableCount: 2, credits: [] });
  for (const bad of [null, 'x', { availableCount: -1 }, { availableCount: 1.5 }, { credits: [] }]) {
    assert.equal(codexAppServerQuota({ rateLimits: snapshot, rateLimitResetCredits: bad }, 'T')?.resetCredits, undefined);
  }
});

test('即時額度查詢：走 initialize → rateLimits/read 取得回應，錯誤或逾時都 reject', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-quota-'));
  try {
    const write = async (name: string, body: string) => { const file = path.join(dir, name); await fs.writeFile(file, body); return file; };
    const ok = await write('ok.ts', `
      let buf = '';
      process.stdin.on('data', d => { buf += d; for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
        if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: m.id, result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null }, secondary: null, rateLimitReachedType: null } } }));
      } });`);
    const quota = await fetchCodexQuota(process.execPath, [ok], process.env);
    assert.deepEqual(quota?.windows, [{ label: '5h', usedPercent: 12, resetsAt: null }]);
    const failing = await write('fail.ts', `process.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) { const m = JSON.parse(l); if (m.method === 'initialize') console.log(JSON.stringify({ id: 1, result: {} })); if (m.id === 2) console.log(JSON.stringify({ id: 2, error: { code: -1, message: 'x' } })); } });`);
    await assert.rejects(fetchCodexQuota(process.execPath, [failing], process.env), /rateLimits\/read failed/);
    const silent = await write('silent.ts', `process.stdin.resume(); setInterval(() => {}, 1000);`);
    await assert.rejects(fetchCodexQuota(process.execPath, [silent], process.env, 300), /timed out/);
    await assert.rejects(fetchCodexQuota('no-such-codex-binary', [], process.env), /not found/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Claude OAuth 用量回應轉成窗口：只收已知窗口、百分比夾在 0–100、達 100% 視為上限', () => {
  const body = {
    five_hour: { utilization: 33.04, resets_at: '2026-10-10T22:59:59.624195+00:00' },
    seven_day: { utilization: 8, resets_at: null },
    seven_day_opus: null,
    iguana_necktie: { utilization: 99, resets_at: '2026-11-05T07:59:00+00:00' },
  };
  assert.deepEqual(claudeOauthQuota(body), {
    limited: false,
    windows: [
      { label: '5h', usedPercent: 33, resetsAt: '2026-10-10T22:59:59.624Z' },
      { label: '7d', usedPercent: 8, resetsAt: null },
    ],
  });
  assert.equal(claudeOauthQuota({ five_hour: { utilization: 120, resets_at: null } })?.limited, true);
  assert.equal(claudeOauthQuota({ five_hour: null }), null);
  assert.equal(claudeOauthQuota('x'), null);
});

test('Claude 重置券：cedar_ember.grants 依剩餘次數展開、略過過期與用盡者、依到期日排序，缺欄位忽略', () => {
  const now = Date.parse('2026-10-11T00:00:00Z');
  const grant = (label: unknown, left: unknown, ends: unknown) => ({ id: 'g', label, resets_left: left, ends_at: ends });
  assert.deepEqual(claudeResetCredits({ cedar_ember: { grants: [
    grant('later', 2, '2026-11-01T00:00:00+00:00'),
    grant('soon', 1, '2026-10-22T16:00:00+00:00'),
    grant('used', 0, '2026-10-30T00:00:00+00:00'),
    grant('expired', 1, '2026-10-01T00:00:00+00:00'),
    grant(null, 1, null),
    'junk',
  ] } }, now), {
    availableCount: 4,
    credits: [
      { title: 'soon', expiresAt: '2026-10-22T16:00:00.000Z' },
      { title: 'later', expiresAt: '2026-11-01T00:00:00.000Z' },
      { title: 'later', expiresAt: '2026-11-01T00:00:00.000Z' },
      { title: null, expiresAt: null },
    ],
  });
  assert.deepEqual(claudeResetCredits({ cedar_ember: { grants: [] } }, now), { availableCount: 0, credits: [] });
  assert.equal(claudeResetCredits({ cedar_ember: { eligible: false } }, now), undefined);
  assert.equal(claudeResetCredits({}, now), undefined);
});

test('Claude 即時用量查詢：帶 Bearer 憑證與 beta 標頭，HTTP 錯誤與缺憑證都 reject', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-quota-'));
  const seen: Record<string, string | undefined>[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, beta: req.headers['anthropic-beta'] as string | undefined, agent: req.headers['user-agent'] });
    if (req.headers.authorization !== 'Bearer tok-1') { res.writeHead(401).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ five_hour: { utilization: 12, resets_at: null }, cedar_ember: { grants: [{ label: 'launch', resets_left: 1, ends_at: '2099-01-01T00:00:00Z' }] } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/usage`;
  try {
    // 只在非 macOS 才一定走檔案；macOS 會先試鑰匙圈，這裡用 CLAUDE_CONFIG_DIR 只驗證檔案路徑的行為。
    const creds = (token: string, expiresAt: number) => fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    // HTTP 部分用注入的憑證讀取，在所有平台都跑。
    const quota1 = await fetchClaudeQuota(env, 2000, url, async () => 'tok-1');
    assert.deepEqual(quota1?.windows, [{ label: '5h', usedPercent: 12, resetsAt: null }]);
    assert.equal(seen[0]?.auth, 'Bearer tok-1');
    assert.equal(seen[0]?.beta, 'oauth-2025-04-20');
    assert.notEqual(seen[0]?.agent, 'claude-cli/2.1.296 (external, cli)');
    assert.deepEqual(quota1?.resetCredits, { availableCount: 1, credits: [{ title: 'launch', expiresAt: '2099-01-01T00:00:00.000Z' }] });
    await fetchClaudeQuota(env, 2000, url, async () => 'tok-1', '2.1.296');
    assert.equal(seen.at(-1)?.agent, 'claude-cli/2.1.296 (external, cli)');
    await assert.rejects(fetchClaudeQuota(env, 2000, url, async () => 'bad'), /401/);
    if (process.platform !== 'darwin') {
      await creds('tok-1', Date.now() + 60_000);
      const quota = await fetchClaudeQuota(env, 2000, url);
      assert.deepEqual(quota?.windows, [{ label: '5h', usedPercent: 12, resetsAt: null }]);
      assert.equal(seen.at(-1)?.auth, 'Bearer tok-1');
      await creds('bad', Date.now() + 60_000);
      await assert.rejects(fetchClaudeQuota(env, 2000, url), /401/);
      await creds('tok-1', Date.now() - 1);
      await assert.rejects(fetchClaudeQuota(env, 2000, url), /expired/);
      await fs.rm(path.join(dir, '.credentials.json'));
      await assert.rejects(fetchClaudeQuota(env, 2000, url), /not found/);
    }
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Claude extra_usage：餘額＝月上限－已用，缺幣別預設 USD，沒有／未啟用／沒上限都是 0，格式錯誤忽略', () => {
  assert.deepEqual(claudeExtraUsage({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234.5, utilization: 24.7, currency: 'eur' } }), { unlimited: false, currency: 'EUR', balance: 3765.5 });
  assert.equal(claudeExtraUsage({ extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 300 } })?.balance, 0);
  assert.equal(claudeExtraUsage({ extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 5 } })?.balance, 0);
  assert.equal(claudeExtraUsage({ extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 0 } })?.balance, 0);
  for (const none of [{ extra_usage: null }, {}]) assert.deepEqual(claudeExtraUsage(none), { unlimited: false, currency: 'USD', balance: 0 });
  for (const bad of [{ extra_usage: { monthly_limit: 1 } }, { extra_usage: 5 }, null]) assert.equal(claudeExtraUsage(bad), undefined);
});

test('Codex credits：balance 是美元的十進位字串（換算成 cents），沒有數字的餘額視為 0', () => {
  assert.deepEqual(codexExtraUsage({ hasCredits: true, unlimited: false, balance: '12.5' }), { unlimited: false, currency: 'USD', balance: 1250 });
  assert.equal(codexExtraUsage({ hasCredits: false, unlimited: false, balance: '0' })?.balance, 0);
  assert.equal(codexExtraUsage({ hasCredits: true, unlimited: true, balance: null })?.balance, 0);
  assert.equal(codexExtraUsage({ hasCredits: true, unlimited: false, balance: 'abc' })?.balance, 0);
  for (const bad of [null, 'x', { hasCredits: true }, { unlimited: false }]) assert.equal(codexExtraUsage(bad), undefined);
  const quota = codexAppServerQuota({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1791948586 }, credits: { hasCredits: true, unlimited: false, balance: '3' } } }, 'T');
  assert.equal(quota?.extraUsage?.balance, 300);
});
