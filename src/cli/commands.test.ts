import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexPrompts, expandCodexPrompt, normalizeCommands, promptArguments, slashName } from './commands.ts';
import { CodexCliProvider } from './codex.ts';
import { createClaudeParser } from './claude.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import type { CliEvent } from './provider.ts';

test('CLI discovery offers every real command and alias except login, logout and model, and drops malformed metadata', () => {
  assert.deepEqual(normalizeCommands([
    { name: 'compact', description: 'Summarize', argumentHint: '[instructions]', builtin: true },
    { name: 'clear', description: 'New session', aliases: ['reset', 3], builtin: true },
    { name: 'model', description: 'Transient model', builtin: true },
    { name: 'login', description: 'Sign in', builtin: true },
    { name: 'account', description: 'Account', aliases: ['logout'] },
    { name: 'config', description: 'Transient setting', aliases: ['settings'], builtin: true },
    { name: 'plugin:deploy', description: 'Real skill' },
    { name: '__hidden', description: 'Internal' },
    { name: 'bad name', description: 'Bad' },
    { name: 'missing-description' }, null,
  ]), [
    { name: 'account', description: 'Account' },
    { name: 'clear', description: 'New session' },
    { name: 'compact', description: 'Summarize', argumentHint: '[instructions]' },
    { name: 'config', description: 'Transient setting' },
    { name: 'plugin:deploy', description: 'Real skill' },
    { name: 'reset', description: 'New session' },
    { name: 'settings', description: 'Transient setting' },
  ]);
  assert.equal(slashName('  /prompts:review FILE="a b"'), 'prompts:review');
  assert.equal(slashName('explain /compact'), null);
});

test('Codex custom discovery is profile isolated, bounded, top-level and ignores symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-prompts-'));
  try {
    const a = path.join(root, 'a'); const b = path.join(root, 'b');
    await fs.mkdir(path.join(a, 'prompts', 'nested'), { recursive: true });
    await fs.mkdir(path.join(b, 'prompts'), { recursive: true });
    await fs.writeFile(path.join(a, 'prompts', 'review.md'), '---\ndescription: "Review selected file"\nargument-hint: FILE=<path>\n---\nReview $FILE and $1.');
    await fs.writeFile(path.join(b, 'prompts', 'other.md'), 'Other profile.');
    await fs.writeFile(path.join(a, 'prompts', 'nested', 'hidden.md'), 'Nested.');
    await fs.writeFile(path.join(a, 'prompts', 'oversized.md'), 'x'.repeat(100_001));
    await fs.writeFile(path.join(a, 'prompts', 'not-a-prompt.json'), '{}');
    await fs.symlink(path.join(b, 'prompts', 'other.md'), path.join(a, 'prompts', 'linked.md'));
    assert.deepEqual(await codexPrompts(a), [{ name: 'prompts:review', description: 'Review selected file', argumentHint: 'FILE=<path>', body: 'Review $FILE and $1.' }]);
    assert.deepEqual(await codexPrompts(path.join(root, 'missing')), []);
    // exec mode has no app-server built-ins, so discovery is exactly the profile's prompts.
    const provider = new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, mode: 'exec' }, []);
    assert.deepEqual((await provider.commands(root, a)).map(c => c.name), ['prompts:review']);
    assert.deepEqual(await provider.resolveCommand('/prompts:review "first argument" FILE="src/a b.ts"', root, a), { text: 'Review src/a b.ts and first argument.', native: false });
    await assert.rejects(provider.resolveCommand('/prompts:review FILE=x', root, b), AppError);
    await assert.rejects(provider.resolveCommand('/compact', root, a), AppError);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Codex arguments expand quotes, positional/named placeholders and literal dollars without recursive expansion', () => {
  assert.deepEqual(promptArguments(`one "two three" FOCUS='loading state' empty="" escaped\\ space`), ['one', 'two three', 'FOCUS=loading state', 'empty=', 'escaped space']);
  assert.equal(expandCodexPrompt('$1|$2|$9|$FILE|$$FILE|$ARGUMENTS', 'one "two three" FILE="$HOME"'), 'one|two three||$HOME|$FILE|one two three FILE=$HOME');
  assert.throws(() => expandCodexPrompt('$REQUIRED', ''), AppError);
  assert.throws(() => expandCodexPrompt('$ARGUMENTS', ''), AppError);
  assert.throws(() => expandCodexPrompt('x'.repeat(100_001), ''), AppError);
  assert.throws(() => promptArguments('"unterminated'), AppError);
  assert.throws(() => promptArguments('trailing\\'), AppError);
  // Inside double quotes only $ ` " \ are escapes, as in POSIX shells: Windows paths keep their backslashes.
  assert.deepEqual(promptArguments(String.raw`FILE="C:\Users\alice\notes.txt" "a\"b" "c\\d" unquoted\x 'single\n'`), [String.raw`FILE=C:\Users\alice\notes.txt`, 'a"b', String.raw`c\d`, 'unquotedx', String.raw`single\n`]);
});

test('Claude native clear keeps the new resume id without changing usage parsing', () => {
  const events: CliEvent[] = [];
  const parse = createClaudeParser(event => events.push(event));
  parse({ type: 'system', subtype: 'init', session_id: 'before' });
  parse({ type: 'result', session_id: 'after', subtype: 'success', result: 'Cleared', usage: { input_tokens: 2, output_tokens: 0 } });
  assert.deepEqual(events.filter(e => e.type === 'session'), [{ type: 'session', id: 'before' }, { type: 'session', id: 'after' }]);
  assert.ok(events.some(e => e.type === 'result' && e.text === 'Cleared'));
});
