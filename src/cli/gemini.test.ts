import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGeminiParser, GeminiCliProvider, geminiArgs, geminiInput, geminiOutcome, geminiQuota } from './gemini.ts';
import { parseGeminiModels } from '../ai/catalog.ts';
import type { CliEvent } from './provider.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';

const cfg = DEFAULT_CONFIG.cli.gemini;
const step = (fields: Record<string, unknown>) => ({ event: 'step_update', step_update: { conversation_id: 'conv', ...fields } });

test('stream-json steps become deltas, deduped tool labels, summed usage, and a successful result', () => {
  const events: CliEvent[] = [];
  let at = 100;
  const parse = createGeminiParser(ev => events.push(ev), () => at);
  parse({ event: 'init', conversation_id: 'conv', init: { tools: [] } });
  parse(step({ step_index: 0, state: 'DONE', step_type: 'user_input' }));
  at = 200;
  parse(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 } }));
  parse(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } } }));
  parse(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } } }));
  parse(step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { output: 'not answer' } }));
  parse(step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello ' }));
  parse(step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'world' }));
  at = 400;
  parse(step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: 20, output_tokens: 7 } }));
  parse({ event: 'result', result: { conversation_id: 'conv', status: 'SUCCESS', response: 'Hello world\n', usage: { input_tokens: 999, output_tokens: 999 } } });
  assert.deepEqual(events.filter(ev => ev.type === 'delta').map(ev => ev.text), ['Hello ', 'world', '\n']);
  assert.deepEqual(events.filter(ev => ev.type === 'tool'), [{ type: 'tool', text: 'run_command: ls -la' }]);
  assert.deepEqual(events.find(ev => ev.type === 'session'), { type: 'session', id: 'conv' });
  assert.deepEqual(events.filter(ev => ev.type === 'usage').at(-1), { type: 'usage', usage: { input: 30, output: 12, cached: 2 } }, 'the last snapshot is the turn total');
  assert.deepEqual(events.filter(ev => ev.type === 'result'), [{ type: 'result', text: 'Hello world\n' }]);
  assert.deepEqual(events.filter(ev => ev.type === 'tokens').map(ev => ev.count), [5, 12]);
});

test('error results and missing conversation ids never become success', () => {
  for (const result of [{ conversation_id: '', status: 'ERROR', error: 'empty prompt' }, { conversation_id: 'conv', status: 'CANCELLED' }, { conversation_id: '', status: 'SUCCESS', response: 'x' }]) {
    const events: CliEvent[] = [];
    createGeminiParser(ev => events.push(ev))({ event: 'result', result });
    assert.equal(events.some(ev => ev.type === 'result' || ev.type === 'session'), false);
    assert.equal(events.filter(ev => ev.type === 'error').length, 1);
  }
  assert.equal(geminiOutcome({ ok: true, stopped: false }, false, false).ok, false);
  assert.equal(geminiOutcome({ ok: true, stopped: false }, true, true).ok, false);
  assert.equal(geminiOutcome({ ok: true, stopped: false }, true, false).ok, true);
});

test('usage already measured survives a failed or unfinished turn', () => {
  const events: CliEvent[] = [];
  const parse = createGeminiParser(ev => events.push(ev), () => 100);
  parse(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 } }));
  // A replayed snapshot of the same step does not change the total.
  parse(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 } }));
  parse({ event: 'result', result: { conversation_id: 'conv', status: 'ERROR', error: 'tool failed' } });
  assert.deepEqual(events.filter(ev => ev.type === 'usage').at(-1), { type: 'usage', usage: { input: 10, output: 5, cached: 2 } });
  assert.equal(events.filter(ev => ev.type === 'error').length, 1);
});

test('args honor permission mode, model, effort, resume and extra directories; the prompt only travels over stdin', () => {
  const base = { prompt: 'secret prompt', cwd: '/w' };
  assert.deepEqual(geminiArgs(cfg, { ...base, fullAccess: true }), [...cfg.fullAccessArgs, ...cfg.baseArgs]);
  assert.deepEqual(geminiArgs(cfg, { ...base, fullAccess: false, model: 'm', effort: 'high', resumeId: 'c1', addDirs: ['/a', '/b'] }), [...cfg.safeArgs, ...cfg.baseArgs, '--model', 'm', '--effort', 'high', '--conversation', 'c1', '--add-dir', '/a', '--add-dir', '/b']);
  assert.ok(!geminiArgs(cfg, base).join(' ').includes('secret prompt'));
  const line = geminiInput({ ...base, images: ['/i/a.png'] });
  assert.ok(line.endsWith('\n'));
  const message = JSON.parse(line) as { event: string; message: { content: string } };
  assert.equal(message.event, 'user');
  assert.match(message.message.content, /secret prompt[\s\S]*\/i\/a\.png/u);
});

test('agy model list keeps id/label rows and skips status text and duplicates', () => {
  assert.deepEqual(parseGeminiModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-high\tdup\nnot a row\n'), [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', efforts: [], defaultEffort: '' },
  ]);
});

test('provider runs the CLI end to end: stdin message in, conversation id and answer out, nonzero exit fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-gemini-'));
  try {
    const script = path.join(dir, 'agy');
    await fs.writeFile(script, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const content = JSON.parse(input).message.content;
  const fail = content.includes('[fail]');
  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', step_index: 1, text_delta: 'echo:' + content } }) + '\\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: process.argv.includes('--conversation') ? 'resumed' : 'fresh', status: 'SUCCESS', response: 'echo:' + content } }) + '\\n');
  process.exit(fail ? 3 : 0);
});
`, { mode: 0o755 });
    const provider = new GeminiCliProvider({ ...cfg, command: script }, [], { PATH: process.env['PATH'] ?? '' });
    assert.equal(await provider.available(), true);
    const run = async (prompt: string, resumeId?: string) => {
      const events: CliEvent[] = [];
      const outcome = await provider.send({ prompt, cwd: dir, ...(resumeId ? { resumeId } : {}) }, ev => events.push(ev)).done;
      return { events, outcome };
    };
    const first = await run('hi');
    assert.equal(first.outcome.ok, true);
    assert.deepEqual(first.events.find(ev => ev.type === 'session'), { type: 'session', id: 'fresh' });
    assert.deepEqual(first.events.find(ev => ev.type === 'result'), { type: 'result', text: 'echo:hi' });
    assert.deepEqual((await run('hi', 'c')).events.find(ev => ev.type === 'session'), { type: 'session', id: 'resumed' });
    const failed = await run('x [fail]');
    assert.equal(failed.outcome.ok, false);
    assert.equal(failed.events.some(ev => ev.type === 'error'), true);
    const slash = await provider.send({ prompt: 'p', cwd: dir, slashCommand: '/x' }, () => undefined).done;
    assert.equal(slash.ok, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('quota reports preserve independent pools, measured fractions, and exhausted limits', () => {
  const reset = '2026-10-15T06:14:55Z';
  const report = { status: 'SUCCESS', conversation_id: '', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { name: 'Weekly Limit Remaining', remaining_fraction: 0.8, reset_time: reset },
      { name: 'Five Hour Limit Remaining', remaining_fraction: 0, reset_time: reset },
    ] },
    { name: 'Claude and GPT models', buckets: [{ name: 'Weekly Limit Remaining', remaining_fraction: 1, reset_time: reset }] },
  ] } } };
  const quota = geminiQuota(report, reset)!;
  assert.equal(quota.limited, true);
  assert.deepEqual(quota.windows.map(window => window.label), [
    'Gemini Models · Weekly Limit Remaining', 'Gemini Models · Five Hour Limit Remaining', 'Claude and GPT models · Weekly Limit Remaining',
  ]);
  assert.ok(Math.abs(quota.windows[0]!.usedPercent - 20) < 1e-10);
  assert.equal(quota.windows[1]!.usedPercent, 100);
  assert.equal(quota.windows[2]!.usedPercent, 0);
  assert.equal(quota.windows[0]!.resetsAt, reset);
});

test('missing or invalid measurements never invent available quota', () => {
  const report = (bucket: Record<string, unknown>) => ({ status: 'SUCCESS', command: { name: 'usage', data: {
    groups: [{ name: 'Gemini Models', buckets: [bucket] }],
  } } });
  const bucket = { name: 'Weekly Limit Remaining', remaining_fraction: 1, reset_time: '2026-10-15T06:14:55Z' };
  for (const remaining_fraction of [undefined, null, '1', NaN, Infinity, -0.1, 1.1]) {
    assert.equal(geminiQuota(report({ ...bucket, remaining_fraction })), null);
  }
  assert.equal(geminiQuota(report({ ...bucket, reset_time: 'invalid' })), null);
  assert.equal(geminiQuota(report({ ...bucket, disabled: true })), null);
  assert.equal(geminiQuota({ ...report(bucket), status: 'ERROR' }), null);
  assert.equal(geminiQuota({ ...report(bucket), command: { name: 'model' } }), null);
});

test('native Gemini reports discover aliases, execute without sessions, and fail closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-gemini-commands-'));
  const script = path.join(dir, 'cli.ts');
  try {
    await fs.writeFile(script, `
const mode = process.argv[2];
const name = process.argv[3];
if (mode === 'discovery') {
  console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'help', data: { commands: [
    { name: 'usage', aliases: ['quota'], description: 'View usage' },
    { name: 'help', description: 'Show commands' },
    { name: 'broken', description: 'Error report' },
    { name: 'nonzero', description: 'Nonzero exit' },
  ] } } }));
} else if (name === '/usage' || name === '/quota') {
  console.log(JSON.stringify({ status: 'SUCCESS', conversation_id: '', response: 'Gemini Models: 81% remaining',
    command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [
      { name: 'Weekly Limit Remaining', remaining_fraction: 0.81, reset_time: '2026-10-15T06:14:55Z' },
    ] }] } } }));
} else if (name === '/nonzero') {
  console.log(JSON.stringify({ status: 'SUCCESS', response: 'must fail', command: { name: 'nonzero' } }));
  process.exitCode = 3;
} else {
  console.log(JSON.stringify({ status: 'ERROR', response: 'not an answer', command: { name: 'broken' } }));
}
`);
    const provider = new GeminiCliProvider({ ...cfg, command: process.execPath, commandsArgs: [script, 'discovery'], slashArgs: [script, 'report'] }, []);
    assert.deepEqual((await provider.commands(dir)).map(command => command.name), ['broken', 'help', 'nonzero', 'quota', 'usage']);
    const command = await provider.resolveCommand('/quota', dir);
    await assert.rejects(provider.resolveCommand('/model secret prompt', dir), { detail: 'slash_unsupported' });
    await assert.rejects(provider.resolveCommand('/unknown', dir), { detail: 'slash_unsupported' });
    const events: CliEvent[] = [];
    const successful = await provider.send({ prompt: 'system preamble', cwd: dir, resumeId: 'existing-chat', slashCommand: command.text, standalone: command.standalone }, ev => events.push(ev)).done;
    assert.equal(successful.ok, true);
    assert.deepEqual(events.find(ev => ev.type === 'result'), { type: 'result', text: 'Gemini Models: 81% remaining' });
    assert.equal(events.some(ev => ev.type === 'session'), false);
    const quota = events.find(ev => ev.type === 'quota');
    assert.ok(quota?.type === 'quota');
    assert.ok(Math.abs(quota.windows[0]!.usedPercent - 19) < 1e-10);
    for (const slashCommand of ['/broken', '/nonzero']) {
      const failureEvents: CliEvent[] = [];
      const failure = await provider.send({ prompt: '', cwd: dir, slashCommand }, ev => failureEvents.push(ev)).done;
      assert.equal(failure.ok, false);
      assert.equal(failureEvents.some(ev => ev.type === 'error'), true);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
