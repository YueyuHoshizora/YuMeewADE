// 以實測抓到的 CLI 輸出（2026-10-10：claude 2.1.294、codex 0.160.1）當 fixture，驗證解析器與引數組裝。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { ClaudeCliProvider, claudeArgs, claudeQuota, createClaudeParser } from './claude.ts';
import { CodexCliProvider, codexArgs, codexQuota, createCodexParser, readCodexQuota } from './codex.ts';
import { captureCommand, redactArgs } from './process.ts';
import { MockCliProvider } from './mock.ts';
import { createProviders } from './providers.ts';
import type { CliEvent } from './provider.ts';
import { promises as fs } from 'node:fs';
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
    assert.deepEqual(events, []);
    const complete = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: fixture.name, input: fixture.input }] } };
    feed(complete); feed(complete);
    assert.deepEqual(events, [{ type: 'tool', text: fixture.text }]);
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
  assert.deepEqual(Object.keys(createProviders(DEFAULT_CONFIG)), ['claude', 'codex', 'mock']);
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

test('claude：速度從第一個內容增量量到 message_delta，太短的樣本不回報', () => {
  let clock = 0;
  const message = (tokens: number, start: number, firstDelta: number, end: number) => [
    () => { clock = start; return { type: 'stream_event', event: { type: 'message_start', message: { usage: { output_tokens: 1 } } } }; },
    () => { clock = firstDelta; return { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '…' } } }; },
    () => { clock = end; return { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: tokens } } }; },
  ];
  const events: CliEvent[] = [];
  const feed = createClaudeParser(ev => events.push(ev), () => clock);
  // 首字前的 5 秒排隊不算進生成時間；4 個 token 的訊息不足以量速度。
  for (const line of [...message(300, 0, 5000, 8000), ...message(4, 9000, 9100, 9400)]) feed(line());
  assert.deepEqual(events.filter(ev => ev.type === 'speed'), [{ type: 'speed', tokensPerSecond: 100 }]);
});

test('codex：rate_limits 依窗口長度命名、回報已達上限；速度為整回合平均', () => {
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
  let clock = 0;
  const events: CliEvent[] = [];
  const feed = createCodexParser(ev => events.push(ev), () => clock);
  feed({ type: 'turn.started' });
  clock = 4000;
  feed({ type: 'turn.completed', usage: { output_tokens: 200 } });
  assert.deepEqual(events, [{ type: 'speed', tokensPerSecond: 50 }, { type: 'result', text: '' }]);
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
