import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrokParser, GrokCliProvider, grokArgs, grokEnv, grokOutcome, grokPromptBlocks } from './grok.ts';
import { minimalEnv, redactArgs } from './process.ts';
import type { CliEvent } from './provider.ts';
import type { CliCommandConfig } from '../shared/config.ts';

const cfg: CliCommandConfig = { command: 'unavailable-yumeewade-grok-test', baseArgs: ['--output-format', 'streaming-json'], safeArgs: ['--permission-mode', 'dontAsk'], fullAccessArgs: ['--always-approve'], fullAccess: true, quotaArgs: [], authRefreshArgs: [], loginArgs: ['login', '--oauth'], commandsArgs: [], slashArgs: [] };
const end = { type: 'end', stopReason: 'end_turn', sessionId: 'session', requestId: 'request' };

test('native Grok output keeps thoughts/tool output out of answer and reports exact turn usage', () => {
  const events: CliEvent[] = [];
  let at = 100;
  const parse = createGrokParser(ev => events.push(ev), () => at);
  at = 150;
  parse({ type: 'thought', data: 'private reasoning' });
  parse({ type: 'text', data: 'Hello ' });
  parse({ type: 'tool_call', toolCallId: 'one', toolName: 'read_file', title: 'Read source', rawInput: {} });
  parse({ type: 'tool_call', toolCallId: 'one', toolName: 'read_file', title: 'duplicate' });
  parse({ type: 'tool_call_update', toolCallId: 'one', status: 'completed', rawOutput: 'not answer' });
  at = 200;
  parse({ type: 'usage', messageId: 'first', usage: { input_tokens: 10, output_tokens: 8, reasoning_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } });
  at = 250;
  parse({ type: 'text', data: 'world' });
  at = 400;
  parse({ ...end, usage: { input_tokens: 30, output_tokens: 12, reasoning_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 4 } });
  assert.deepEqual(events.filter(ev => ev.type === 'delta').map(ev => ev.text), ['Hello ', 'world']);
  assert.deepEqual(events.filter(ev => ev.type === 'tool'), [{ type: 'tool', text: 'Read source' }]);
  assert.deepEqual(events.filter(ev => ev.type === 'result'), [{ type: 'result', text: 'Hello world' }]);
  assert.deepEqual(events.filter(ev => ev.type === 'usage'), [{ type: 'usage', usage: { input: 34, output: 12, cached: 7 } }]);
  const tokens = events.filter(ev => ev.type === 'tokens');
  assert.deepEqual(tokens.map(({ count, spanMs, at }) => ({ count, spanMs, at })), [{ count: 12, spanMs: 300, at: 400 }]);
});

test('missing/incomplete/malformed usage never becomes fabricated turn usage or speed', () => {
  for (const fields of [{}, { usage_is_incomplete: true, usage: { input_tokens: 9, output_tokens: 4 } }, { usage: { input_tokens: 1, output_tokens: -1 } }, { usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: '5' } }]) {
    const events: CliEvent[] = [];
    const parse = createGrokParser(ev => events.push(ev));
    parse({ type: 'text', data: 'answer' });
    parse({ ...end, ...fields });
    assert.equal(events.some(ev => ev.type === 'usage' || ev.type === 'tokens'), false);
    assert.equal(events.some(ev => ev.type === 'result'), true);
  }
});

test('terminal errors, truncation, cancellation and malformed end cannot become success', () => {
  for (const terminal of [{ type: 'error', message: 'backend failed' }, { type: 'max_turns_reached' }, { ...end, stopReason: 'max_tokens' }, { ...end, stopReason: 'cancelled' }, { ...end, stopReason: 'refusal' }, { ...end, sessionId: '' }, { ...end, structuredOutputError: 'invalid structured output' }]) {
    const events: CliEvent[] = [];
    const parse = createGrokParser(ev => events.push(ev));
    parse({ type: 'text', data: 'partial' });
    parse(terminal);
    parse(end);
    assert.equal(events.filter(ev => ev.type === 'error').length, 1);
    assert.equal(events.some(ev => ev.type === 'result'), false);
  }
  assert.deepEqual(grokOutcome({ ok: true, stopped: false }, false, false), { ok: false, stopped: false, reason: 'no Grok end event' });
  assert.equal(grokOutcome({ ok: true, stopped: false }, true, true).ok, false);
  assert.equal(grokOutcome({ ok: false, stopped: false, reason: 'exit 1' }, true, false).ok, false);
  assert.deepEqual(grokOutcome({ ok: false, stopped: true }, true, false), { ok: false, stopped: true });
});

test('extra Grok profiles pin credentials and leader while preserving default environment', () => {
  const inherited = { HOME: '/home', GROK_HOME: '/default', XAI_API_KEY: 'do-not-use', GROK_AUTH: 'do-not-use', GROK_AUTH_PATH: '/other/auth.json', GROK_LEADER_SOCKET: '/other/leader.sock', GROK_EXTRA_AUTH_KEY: 'do-not-use' };
  assert.equal(grokEnv(inherited), inherited);
  const env = grokEnv(inherited, '/isolated');
  assert.equal(env['GROK_HOME'], '/isolated');
  assert.equal(env['GROK_AUTH_PATH'], path.join('/isolated', 'auth.json'));
  assert.equal(env['GROK_LEADER_SOCKET'], path.join('/isolated', 'leader.sock'));
  for (const key of ['XAI_API_KEY', 'GROK_AUTH', 'GROK_EXTRA_AUTH_KEY']) assert.equal(env[key], undefined);
  assert.equal(inherited.XAI_API_KEY, 'do-not-use');
  assert.deepEqual(minimalEnv([], { GROK_HOME: '/profile', XAI_API_KEY: 'secret' })['GROK_HOME'], '/profile');
  assert.equal(minimalEnv([], { XAI_API_KEY: 'secret' })['XAI_API_KEY'], undefined);
});

test('permission overrides, resume and stdin prompt transport do not expose prompt in argv', () => {
  const opts = { prompt: 'secret prompt', cwd: '/work', fullAccess: false, resumeId: 'old-session', model: 'model-id', effort: 'high' };
  const args = grokArgs(cfg, opts, '/dev/stdin', 'new-id');
  assert.deepEqual(args, ['--permission-mode', 'dontAsk', '--output-format', 'streaming-json', '--prompt-file', '/dev/stdin', '--model', 'model-id', '--reasoning-effort', 'high', '--resume', 'old-session']);
  assert.equal(args.includes(opts.prompt), false);
  assert.equal(args.includes('--session-id'), false);
  assert.equal(grokArgs(cfg, { prompt: opts.prompt, cwd: opts.cwd, fullAccess: true }, '/dev/stdin', 'new-id').includes('--always-approve'), true);
  assert.deepEqual(redactArgs(['--prompt-json', 'secret', '--single', 'secret', '--prompt-file', '/private', '--session-id', 'private-id']), ['--prompt-json', '<…>', '--single', '<…>', '--prompt-file', '<…>', '--session-id', '<…>']);
});

test('image input is native ACP data, not a textual promise to read an attachment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-images-test-'));
  try {
    const filename = path.join(dir, 'image.png');
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await fs.writeFile(filename, bytes);
    assert.deepEqual(await grokPromptBlocks({ prompt: 'inspect', cwd: dir, images: [filename] }), [{ type: 'text', text: 'inspect' }, { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }]);
    await assert.rejects(grokPromptBlocks({ prompt: 'inspect', cwd: dir, images: [path.join(dir, 'missing.png')] }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('provider fails closed for unavailable CLI and unsupported native slash, and stops before spawn', async () => {
  const provider = new GrokCliProvider(cfg, []);
  const events: CliEvent[] = [];
  const opts = { prompt: 'not sent', cwd: os.tmpdir() };
  const unavailable = await provider.send(opts, ev => events.push(ev)).done;
  assert.equal(unavailable.ok, false);
  assert.equal(events.some(ev => ev.type === 'error'), true);
  assert.equal(events.some(ev => ev.type === 'result'), false);
  events.length = 0;
  const slash = await provider.send({ ...opts, slashCommand: '/model' }, ev => events.push(ev)).done;
  assert.equal(slash.ok, false);
  assert.equal(events.some(ev => ev.type === 'error'), true);
  const stopped = provider.send(opts, () => {});
  stopped.stop();
  assert.deepEqual(await stopped.done, { ok: false, stopped: true });
});
