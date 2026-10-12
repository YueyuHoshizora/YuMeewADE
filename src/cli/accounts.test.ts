import assert from 'node:assert/strict';
import { promises as fs, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CredentialVault } from '../credentials/vault.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { CredentialAccounts } from './accounts.ts';
import { createProviders } from './providers.ts';

const codexRecord = (name: string) => JSON.stringify({ tokens: { access_token: `${name}-access`, refresh_token: `${name}-refresh`, id_token: `${name}-id`, account_id: name }, last_refresh: '2026-10-01T00:00:00Z', extension: { preserved: true } });
const grokRecord = (name: string) => JSON.stringify({ 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': { key: `${name}-token`, auth_mode: 'oidc', user_id: name, create_time: '2026-10-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', oidc_issuer: 'https://auth.x.ai', refresh_token: `${name}-refresh`, extension: { preserved: true } } });

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ym-account-test-')));
  const names = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'GROK_AUTH_PATH', 'PATH', 'ANTHROPIC_API_KEY', 'GROK_AUTH', 'GROK_LEADER_SOCKET'];
  const original = new Map(names.map(name => [name, process.env[name]]));
  process.env['HOME'] = root;
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'GROK_AUTH_PATH']) delete process.env[name];
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  if (process.platform !== 'win32') await fs.writeFile(path.join(bin, 'security'), '#!/usr/bin/env node\nprocess.exit(44);\n', { mode: 0o700 });
  process.env['PATH'] = bin + path.delimiter + (original.get('PATH') ?? '');
  process.env['ANTHROPIC_API_KEY'] = 'must-not-escape';
  process.env['GROK_AUTH'] = 'must-not-escape';
  process.env['GROK_LEADER_SOCKET'] = '/global-default-socket';
  const vault = await CredentialVault.open(path.join(root, 'store'), {
    encrypt: async text => Buffer.from(text),
    decrypt: async bytes => Buffer.from(bytes).toString('utf8'),
    close: async () => {},
  });
  const accounts = new CredentialAccounts(vault, path.join(root, 'app'), ['ANTHROPIC_API_KEY', 'GROK_AUTH', 'GROK_LEADER_SOCKET']);
  const source = async (ai: string, directory: string, record: string) => {
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, ai === 'claude' ? '.credentials.json' : 'auth.json');
    await fs.writeFile(file, record);
    return file;
  };
  const cleanup = async () => {
    await accounts.close();
    vault.close();
    for (const [name, value] of original) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, accounts, vault, source, cleanup };
}

test('import is DB-authoritative; default and explicit profiles never share identity or mutate originals', async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, '.codex');
    const file = await f.source('codex', home, codexRecord('first'));
    await f.accounts.import('codex');
    await fs.writeFile(file, codexRecord('extra'));
    await f.accounts.import('codex', home);
    await fs.writeFile(file, 'source no longer contains credentials');
    await f.accounts.import('codex');
    const seen: string[] = [];
    for (const configDir of [undefined, home]) {
      await f.accounts.withEnv('codex', configDir, async env => {
        seen.push(await fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'));
        assert.notEqual(env['CODEX_HOME'], home);
      });
    }
    assert.deepEqual(seen, [codexRecord('first'), codexRecord('extra')]);
    assert.equal(await fs.readFile(file, 'utf8'), 'source no longer contains credentials');
    await f.accounts.remove('codex');
    await assert.rejects(f.accounts.withEnv('codex', undefined, async () => assert.fail('missing credential callback')), /Account credentials unavailable/);
    await f.accounts.withEnv('codex', home, async env => assert.equal(await fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'), codexRecord('extra')));
  } finally { await f.cleanup(); }
});

test('activate overwrites only the default slot from an added account and rejects while the slot is in use', async () => {
  const f = await fixture();
  try {
    const cliHome = path.join(f.root, '.codex');
    const cliFile = await f.source('codex', cliHome, codexRecord('cli-login'));
    const extra = path.join(f.root, 'extra');
    await f.source('codex', extra, codexRecord('extra'));
    await f.accounts.import('codex', extra);
    await assert.rejects(f.accounts.activate('codex', path.join(f.root, 'unknown')), /Account credentials unavailable/);
    await f.accounts.activate('codex', extra);
    await f.accounts.withEnv('codex', undefined, async env => {
      assert.equal(await fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'), codexRecord('extra'));
      await assert.rejects(f.accounts.activate('codex', extra), /Account credentials unavailable/);
    });
    assert.equal(await fs.readFile(cliFile, 'utf8'), codexRecord('cli-login'));
  } finally { await f.cleanup(); }
});

test('undoing an activation puts the slot back to what it held before, or empties it', async () => {
  const f = await fixture();
  try {
    const [first, second] = [path.join(f.root, 'first'), path.join(f.root, 'second')];
    await f.source('codex', first, codexRecord('first')); await f.source('codex', second, codexRecord('second'));
    await f.accounts.import('codex', first); await f.accounts.import('codex', second);
    const slot = () => f.accounts.withEnv('codex', undefined, async env => fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'));
    const undoFirst = await f.accounts.activate('codex', first);
    await (await f.accounts.activate('codex', second))();
    assert.equal(await slot(), codexRecord('first'));
    await undoFirst();
    assert.equal(f.accounts.hasStored('codex'), false);
  } finally { await f.cleanup(); }
});

test('credentials left behind by a crashed run never override an explicit activate, import or remove', async () => {
  const f = await fixture();
  try {
    const extra = path.join(f.root, 'extra');
    await f.source('codex', path.join(f.root, '.codex'), codexRecord('first'));
    await f.source('codex', extra, codexRecord('extra'));
    await f.accounts.import('codex');
    await f.accounts.import('codex', extra);
    let slot = '';
    await f.accounts.withEnv('codex', undefined, async env => { slot = env['CODEX_HOME']!; });
    // A killed core never reaches release(): the run's auth file stays in the runtime home.
    const crash = () => fs.writeFile(path.join(slot, 'auth.json'), codexRecord('crashed'), { mode: 0o600 });
    const current = () => f.accounts.withEnv('codex', undefined, async env => fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'));
    await crash();
    await f.accounts.activate('codex', extra);
    assert.equal(await current(), codexRecord('extra'));
    await crash();
    await f.accounts.import('codex', undefined, true);
    assert.equal(await current(), codexRecord('first'));
    await crash();
    await f.accounts.remove('codex');
    await f.accounts.import('codex');
    assert.equal(await current(), codexRecord('first'));
    // Without an explicit change, the leftover is still the newest token and is recovered as before.
    await crash();
    assert.equal(await current(), codexRecord('crashed'));
  } finally { await f.cleanup(); }
});

const geminiRecord = (token: string) => JSON.stringify({ token: { access_token: token, refresh_token: 'refresh', token_type: 'Bearer', expiry: '2030-01-01T00:00:00Z' }, auth_method: 'oauth', id_token: 'id' });
const geminiToken = (home: string) => path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

test('Gemini accounts run under an isolated HOME, flush refreshed tokens back, and activate into the default slot', async () => {
  const f = await fixture();
  try {
    const profile = path.join(f.root, 'profile');
    await fs.mkdir(path.dirname(geminiToken(profile)), { recursive: true });
    await fs.writeFile(geminiToken(profile), geminiRecord('first'));
    await assert.rejects(f.accounts.import('gemini', path.join(f.root, 'missing')), /Account credentials unavailable/);
    await f.accounts.import('gemini', profile);
    let runtimeToken = '';
    await f.accounts.withEnv('gemini', profile, async env => {
      assert.notEqual(env['HOME'], f.root);
      assert.equal(env['USERPROFILE'], env['HOME']);
      runtimeToken = geminiToken(env['HOME']!);
      assert.equal(await fs.readFile(runtimeToken, 'utf8'), geminiRecord('first'));
      await fs.writeFile(runtimeToken, geminiRecord('refreshed'));
    });
    await assert.rejects(fs.stat(runtimeToken), { code: 'ENOENT' });
    await f.accounts.withEnv('gemini', profile, async env => assert.equal(await fs.readFile(geminiToken(env['HOME']!), 'utf8'), geminiRecord('refreshed')));
    await f.accounts.activate('gemini', profile);
    await f.accounts.withEnv('gemini', undefined, async env => {
      assert.equal(await fs.readFile(geminiToken(env['HOME']!), 'utf8'), geminiRecord('refreshed'));
      assert.notEqual(env['HOME'], profile);
    });
    assert.equal(await fs.readFile(geminiToken(profile), 'utf8'), geminiRecord('first'));
    await fs.writeFile(geminiToken(profile), '{"token":{}}');
    await assert.rejects(f.accounts.import('gemini', profile, true), /Account credentials unavailable/);
  } finally { await f.cleanup(); }
});

test('native callbacks overlap on one auth store; releases flush refreshes without deleting another live lease', async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, '.codex');
    const file = await f.source('codex', home, codexRecord('original'));
    await fs.writeFile(path.join(home, 'config.toml'), 'model = "fixture-model"\n');
    await fs.mkdir(path.join(home, 'sessions'));
    await fs.writeFile(path.join(home, 'sessions', 'existing.jsonl'), 'existing session');
    await fs.writeFile(path.join(home, 'auth.json.backup'), 'must not copy credentials');
    await f.accounts.import('codex');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let runtime = '';
    const first = f.accounts.withEnv('codex', undefined, async env => {
      runtime = env['CODEX_HOME']!;
      assert.equal(await fs.readFile(path.join(runtime, 'config.toml'), 'utf8'), 'model = "fixture-model"\n');
      assert.equal(await fs.readFile(path.join(runtime, 'sessions', 'existing.jsonl'), 'utf8'), 'existing session');
      await assert.rejects(fs.access(path.join(runtime, 'auth.json.backup')));
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const second = f.accounts.withEnv('codex', undefined, async env => {
      assert.equal(env['CODEX_HOME'], runtime);
      assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), codexRecord('original'));
      await fs.writeFile(path.join(runtime, 'auth.json'), codexRecord('refreshed'));
      await fs.writeFile(path.join(runtime, 'sessions', 'new.jsonl'), 'new session');
    });
    await second;
    assert.equal(await fs.readFile(path.join(runtime, 'auth.json'), 'utf8'), codexRecord('refreshed'));
    release.resolve();
    await first;
    await assert.rejects(fs.access(path.join(runtime, 'auth.json')));
    assert.equal(await fs.readFile(file, 'utf8'), codexRecord('original'));
    assert.equal(await fs.readFile(path.join(home, 'sessions', 'existing.jsonl'), 'utf8'), 'existing session');
    await assert.rejects(fs.access(path.join(home, 'sessions', 'new.jsonl')));
    await assert.rejects(f.accounts.withEnv('codex', undefined, async () => { throw new Error('secret error'); }), { message: 'Account credentials unavailable.' });
    await assert.rejects(fs.access(path.join(runtime, 'auth.json')));
  } finally { await f.cleanup(); }
});

test('Claude managed roots preserve copied nonauth state; Grok auth-only leases isolate auth and leader sockets', async () => {
  const f = await fixture();
  try {
    const claude = path.join(f.root, '.claude');
    const claudeText = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 60_000 }, extension: 'retained' });
    const claudeFile = await f.source('claude', claude, claudeText);
    const grok = path.join(f.root, '.grok');
    const grokFile = await f.source('grok', grok, grokRecord('original'));
    await f.accounts.import('claude', claude);
    await f.accounts.import('grok');
    let claudeRuntime = '';
    let grokRuntime = '';
    await f.accounts.withEnv('claude', claude, async env => {
      assert.notEqual(env['CLAUDE_CONFIG_DIR'], claude);
      claudeRuntime = env['CLAUDE_CONFIG_DIR']!;
      assert.notEqual(claudeRuntime, claude);
      assert.equal(await fs.readFile(path.join(claudeRuntime, '.credentials.json'), 'utf8'), claudeText);
      assert.equal(env['ANTHROPIC_API_KEY'], undefined);
    });
    await f.accounts.withEnv('grok', undefined, async env => {
      assert.notEqual(env['GROK_HOME'], grok);
      grokRuntime = path.dirname(env['GROK_AUTH_PATH']!);
      assert.equal(env['GROK_HOME'], grokRuntime);
      assert.notEqual(path.dirname(env['GROK_LEADER_SOCKET']!), grok);
      assert.notEqual(grokRuntime, grok);
      assert.equal(env['GROK_AUTH'], undefined);
      await fs.writeFile(env['GROK_AUTH_PATH']!, grokRecord('refreshed'));
      await fs.writeFile(path.join(grokRuntime, 'auth.json.corrupt.fixture'), 'temporary backup');
    });
    await assert.rejects(fs.access(path.join(claudeRuntime, '.credentials.json')));
    await assert.rejects(fs.access(path.join(grokRuntime, 'auth.json')));
    await assert.rejects(fs.access(path.join(grokRuntime, 'auth.json.corrupt.fixture')));
    assert.equal(await fs.readFile(claudeFile, 'utf8'), claudeText);
    assert.equal(await fs.readFile(grokFile, 'utf8'), grokRecord('original'));
    await f.accounts.withEnv('grok', undefined, async env => assert.equal(await fs.readFile(env['GROK_AUTH_PATH']!, 'utf8'), grokRecord('refreshed')));
  } finally { await f.cleanup(); }
});

test('quota consumes vault data directly after original changes and missing credentials never issue HTTP', async t => {
  const f = await fixture();
  try {
    const file = await f.source('grok', path.join(f.root, '.grok'), grokRecord('stored'));
    await f.accounts.import('grok');
    await fs.writeFile(file, grokRecord('wrong-source'));
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      calls++;
      assert.equal((init.headers as Record<string, string>)['Authorization'], 'Bearer stored-token');
      assert.equal((init.headers as Record<string, string>)['x-userid'], 'stored');
      return Response.json({ config: { creditUsagePercent: 12 } });
    });
    const providers = createProviders(DEFAULT_CONFIG, f.accounts);
    assert.equal((await providers['grok']!.quota!())?.windows[0]?.usedPercent, 12);
    await assert.rejects(providers['grok']!.quota!(path.join(f.root, 'missing')), /Account credentials unavailable/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

for (const ai of ['claude', 'grok'] as const) test(`${ai} quota renews expired credentials, persists renewal and fails closed on refresh errors`, async t => {
  const f = await fixture();
  try {
    const credential = (token: string, expires: string) => ai === 'claude'
      ? JSON.stringify({ claudeAiOauth: { accessToken: `${token}-token`, refreshToken: 'fixture-refresh', expiresAt: Date.parse(expires) } })
      : grokRecord(token).replace('2099-01-01T00:00:00Z', expires);
    const expired = credential('stale', '2020-01-01T00:00:00Z');
    const renewed = credential('renewed', '2099-01-01T00:00:00Z');
    const source = await f.source(ai, path.join(f.root, `.${ai}`), expired);
    await f.accounts.import(ai);
    const cli = path.join(f.root, 'renew.ts');
    const authPath = ai === 'claude' ? "path.join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json')" : 'process.env.GROK_AUTH_PATH!';
    await fs.writeFile(cli, `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(${authPath}, ${JSON.stringify(renewed)});`);
    const tokens: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      tokens.push((init.headers as Record<string, string>)['Authorization']!);
      return Response.json(ai === 'claude' ? { five_hour: { utilization: 30, resets_at: '2099-01-01T00:00:00Z' } } : { config: { creditUsagePercent: 30 } });
    });
    const provider = f.accounts.provider(ai, { ...DEFAULT_CONFIG.cli[ai], command: process.execPath, authRefreshArgs: [cli] });
    assert.equal((await provider.quota!())?.windows[0]?.usedPercent, 30);
    // A persisted renewal remains usable even when the refresh command later fails.
    await fs.writeFile(cli, 'process.exit(3);');
    assert.equal((await provider.quota!())?.windows[0]?.usedPercent, 30);
    assert.deepEqual(tokens, ['Bearer renewed-token', 'Bearer renewed-token']);
    assert.equal(await fs.readFile(source, 'utf8'), expired);
    await f.accounts.import(ai, undefined, true);
    await assert.rejects(provider.quota!(), { message: 'Account credentials unavailable.' });
    assert.deepEqual(tokens, ['Bearer renewed-token', 'Bearer renewed-token']);
    await f.accounts.withEnv(ai, undefined, async env => {
      const file = ai === 'claude' ? path.join(env['CLAUDE_CONFIG_DIR']!, '.credentials.json') : env['GROK_AUTH_PATH']!;
      assert.equal(await fs.readFile(file, 'utf8'), expired);
    });
  } finally { await f.cleanup(); }
});

test('stop before async preparation does not spawn; close drains running native processes and plaintext cleanup', async () => {
  const f = await fixture();
  try {
    await f.source('grok', path.join(f.root, '.grok'), grokRecord('stored'));
    await f.accounts.import('grok');
    const marker = path.join(f.root, 'started');
    const cli = path.join(f.root, 'fixture-cli.js');
    await fs.writeFile(cli, `const fs=require('node:fs');fs.watch(__filename,()=>{});fs.writeFileSync(${JSON.stringify(marker + '.tmp')},process.env.GROK_AUTH_PATH);fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});`);
    const provider = f.accounts.provider('grok', { ...DEFAULT_CONFIG.cli.grok, command: process.execPath, baseArgs: [cli], safeArgs: [], fullAccessArgs: [] });
    const stopped = provider.send({ prompt: 'fixture only', cwd: f.root }, () => {});
    stopped.stop();
    assert.equal((await stopped.done).stopped, true);
    await assert.rejects(fs.access(marker));
    const started = Promise.withResolvers<void>();
    const watcher = watch(f.root, (_event, name) => { if (name === 'started') started.resolve(); });
    const running = provider.send({ prompt: 'fixture only', cwd: f.root }, () => {});
    try { await Promise.race([started.promise, running.done.then(() => assert.fail('fixture exited before start'))]); }
    finally { watcher.close(); }
    const authFile = await fs.readFile(marker, 'utf8');
    await f.accounts.close();
    assert.equal((await running.done).stopped, true);
    await assert.rejects(fs.access(authFile));
    await assert.rejects(f.accounts.withEnv('grok', undefined, async () => assert.fail('closed broker callback')));
  } finally { await f.cleanup(); }
});

test('malformed, oversized, missing and alternate-auth configurations fail closed without changing source files', async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, '.codex');
    const file = await f.source('codex', home, 'invalid-private-value');
    await assert.rejects(f.accounts.import('codex'), { message: 'Account credentials unavailable.' });
    await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(f.accounts.import('codex'), { message: 'Account credentials unavailable.' });
    await assert.rejects(f.accounts.import('grok', path.join(f.root, 'missing')), { message: 'Account credentials unavailable.' });
    const grok = path.join(f.root, '.grok');
    await f.source('grok', grok, grokRecord('stored'));
    await fs.writeFile(path.join(grok, 'config.toml'), '[auth]\nauth_provider_command = "external-login"\n');
    await f.accounts.import('grok');
    await assert.rejects(f.accounts.withEnv('grok', undefined, async () => assert.fail('alternate auth callback')));
    assert.equal(await fs.readFile(path.join(grok, 'config.toml'), 'utf8'), '[auth]\nauth_provider_command = "external-login"\n');
  } finally { await f.cleanup(); }
});

test('real adapter execution reads canonical stored auth, isolates extra profiles, and commits native file refresh', async () => {
  const f = await fixture();
  try {
    const defaultDir = path.join(f.root, '.grok');
    const extraDir = path.join(f.root, 'extra-grok');
    const original = await f.source('grok', defaultDir, grokRecord('default'));
    const extra = await f.source('grok', extraDir, grokRecord('extra'));
    await f.accounts.import('grok');
    await f.accounts.import('grok', extraDir);
    await fs.writeFile(original, grokRecord('wrong-default'));
    await fs.writeFile(extra, grokRecord('wrong-extra'));
    const cli = path.join(f.root, 'native-refresh.js');
    await fs.writeFile(cli, `
const fs = require('node:fs');
const file = process.env.GROK_AUTH_PATH;
const store = JSON.parse(fs.readFileSync(file, 'utf8'));
const auth = Object.values(store)[0];
const text = auth.user_id;
auth.key = text + '-native-refresh';
fs.writeFileSync(file, JSON.stringify(store));
process.stdout.write(JSON.stringify({type:'text',data:text})+'\\n');
process.stdout.write(JSON.stringify({type:'end',sessionId:'fixture-session',stopReason:'end_turn'})+'\\n');
`);
    const provider = f.accounts.provider('grok', { ...DEFAULT_CONFIG.cli.grok, command: process.execPath, baseArgs: [cli], safeArgs: [], fullAccessArgs: [] });
    for (const [configDir, expected] of [[undefined, 'default'], [extraDir, 'extra']] as const) {
      let result = '';
      const outcome = await provider.send({ prompt: 'fixture only', cwd: f.root, ...(configDir ? { configDir } : {}) }, event => { if (event.type === 'result') result = event.text; }).done;
      assert.equal(outcome.ok, true);
      assert.equal(result, expected);
      await f.accounts.withEnv('grok', configDir, async env => {
        const store = JSON.parse(await fs.readFile(env['GROK_AUTH_PATH']!, 'utf8')) as Record<string, { key: string }>;
        assert.equal(Object.values(store)[0]!.key, `${expected}-native-refresh`);
      });
    }
    assert.equal(await fs.readFile(original, 'utf8'), grokRecord('wrong-default'));
    assert.equal(await fs.readFile(extra, 'utf8'), grokRecord('wrong-extra'));
  } finally { await f.cleanup(); }
});

test('Codex auto imports the native Keychain record before stale source auth.json', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, '.codex');
    const file = await f.source('codex', home, codexRecord('stale-file'));
    await fs.writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "auto"\n');
    const keychainRecord = codexRecord('native-keychain');
    await fs.writeFile(path.join(f.root, 'bin', 'security'), `#!/usr/bin/env node
if (process.argv[2] === 'find-generic-password') process.stdout.write(${JSON.stringify(keychainRecord)});
else process.exit(44);
`, { mode: 0o700 });
    await f.accounts.import('codex');
    await f.accounts.withEnv('codex', undefined, async env => {
      assert.equal(await fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'), keychainRecord);
    });
    assert.equal(await fs.readFile(file, 'utf8'), codexRecord('stale-file'));
  } finally { await f.cleanup(); }
});

test('Claude native managed-Keychain refresh is vaulted back and deletes only the generated service', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, '.claude');
    const initial = JSON.stringify({ claudeAiOauth: { accessToken: 'original-access', refreshToken: 'original-refresh', expiresAt: 1 } });
    const refreshed = JSON.stringify({ claudeAiOauth: { accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh', expiresAt: 2099000000000 }, completeRecord: 'retained' });
    const original = await f.source('claude', home, initial);
    await f.accounts.import('claude', home);
    const managedKeychain = path.join(f.root, 'managed-keychain-fixture');
    const deletedService = path.join(f.root, 'deleted-service');
    const security = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'find-generic-password') {
  if (fs.existsSync(${JSON.stringify(managedKeychain)})) process.stdout.write(fs.readFileSync(${JSON.stringify(managedKeychain)}));
  else process.exit(44);
} else if (process.argv[2] === 'delete-generic-password') {
  fs.writeFileSync(${JSON.stringify(deletedService)}, process.argv[4]);
  fs.rmSync(${JSON.stringify(managedKeychain)}, { force: true });
} else process.exit(44);
`;
    await fs.writeFile(path.join(f.root, 'bin', 'security'), security, { mode: 0o700 });
    let runtime = '';
    await f.accounts.withEnv('claude', home, async env => {
      runtime = env['CLAUDE_CONFIG_DIR']!;
      await fs.writeFile(managedKeychain, refreshed);
    });
    const service = await fs.readFile(deletedService, 'utf8');
    assert.match(service, /^Claude Code-credentials-[0-9a-f]{8}$/);
    assert.notEqual(service, 'Claude Code-credentials');
    await assert.rejects(fs.access(path.join(runtime, '.credentials.json')));
    await assert.rejects(fs.access(managedKeychain));
    await f.accounts.withEnv('claude', home, async env => assert.equal(await fs.readFile(path.join(env['CLAUDE_CONFIG_DIR']!, '.credentials.json'), 'utf8'), refreshed));
    assert.equal(await fs.readFile(original, 'utf8'), initial);
  } finally { await f.cleanup(); }
});

test('stop during blocked asynchronous preparation resolves promptly; close drains orphan acquisition and cleanup', async t => {
  const f = await fixture();
  try {
    await f.source('grok', path.join(f.root, '.grok'), grokRecord('stored'));
    await f.accounts.import('grok');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = f.vault.read.bind(f.vault);
    t.mock.method(f.vault, 'read', async (ai: string, profile: string) => {
      entered.resolve();
      await release.promise;
      return read(ai, profile);
    });
    const provider = f.accounts.provider('grok', { ...DEFAULT_CONFIG.cli.grok, command: '/missing-fixture-cli' });
    const run = provider.send({ prompt: 'never spawned', cwd: f.root }, () => assert.fail('canceled preparation event'));
    await entered.promise;
    run.stop();
    assert.equal((await run.done).stopped, true);
    const closing = f.accounts.close();
    release.resolve();
    await closing;
    const providerDirectory = path.join(f.root, 'app', 'cli-accounts', 'grok');
    for (const directory of await fs.readdir(providerDirectory)) {
      await assert.rejects(fs.access(path.join(providerDirectory, directory, 'auth.json')));
    }
  } finally { await f.cleanup(); }
});
