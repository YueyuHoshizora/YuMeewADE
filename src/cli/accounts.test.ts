import assert from 'node:assert/strict';
import { promises as fs, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CredentialVault } from '../credentials/vault.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { CredentialAccounts } from './accounts.ts';
import { createProviders } from './providers.ts';
import { App } from '../server/app.ts';
import { QuotaAuthenticationRequired } from './provider.ts';

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

test('workspace linking never relabels a newer slot belonging to another account, including after restart', async () => {
  const f = await fixture();
  let restarted: CredentialAccounts | undefined;
  try {
    const a = path.join(f.root, 'workspace-a');
    const b = path.join(f.root, 'workspace-b');
    const newerA = codexRecord('account-A').replace('2026-10-01', '2026-10-12');
    await f.source('codex', a, newerA);
    await f.source('codex', b, codexRecord('account-B'));
    await f.accounts.import('codex', a);
    await f.accounts.import('codex', b);
    await f.accounts.activate('codex', a);
    const check = async (accounts: CredentialAccounts, directory: string | undefined, expected: string) => {
      const actual = await accounts.withEnv('codex', directory, async env => {
        const value = JSON.parse(await fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'));
        return value.tokens.account_id as string;
      });
      assert.equal(actual, expected);
    };
    await f.accounts.link('codex', b);
    await check(f.accounts, undefined, 'account-B');
    await check(f.accounts, b, 'account-B');
    await f.accounts.link('codex', a);
    await check(f.accounts, b, 'account-B');
    await f.accounts.close();
    restarted = new CredentialAccounts(f.vault, path.join(f.root, 'app'), []);
    await restarted.link('codex', b);
    await check(restarted, undefined, 'account-B');
    await check(restarted, a, 'account-A');
    await restarted.link('codex', a);
    await check(restarted, b, 'account-B');
  } finally { await restarted?.close(); await f.cleanup(); }
});

test('legacy raw slots with unknown ownership never override a selected account by refresh time', async () => {
  const f = await fixture();
  try {
    const b = path.join(f.root, 'b');
    await f.source('codex', b, codexRecord('B'));
    await f.accounts.import('codex', b);
    const key = JSON.stringify(['default', path.join(f.root, '.codex'), '']);
    await f.vault.write('codex', key, codexRecord('A').replace('2026-10-01', '2026-10-12'));
    await f.accounts.link('codex', b);
    const actual = await f.accounts.withEnv('codex', undefined, async env =>
      fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'));
    assert.equal(actual, codexRecord('B'));
  } finally { await f.cleanup(); }
});

test('removing a leased account deletes its authorization and cannot resurrect it or reuse it on reimport', async () => {
  const f = await fixture();
  const app = new App({ ...DEFAULT_CONFIG, workspace: { root: path.join(f.root, 'workspace') } }, { accounts: f.accounts, providers: {}, home: f.root });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let running: Promise<unknown> | undefined;
  try {
    await app.ws.init();
    const [a, b] = [path.join(f.root, 'a'), path.join(f.root, 'b')];
    await f.source('codex', a, codexRecord('A'));
    const file = await f.source('codex', b, codexRecord('B-old'));
    await app.settings.addAccount('codex', 'A', a);
    const settings = await app.settings.addAccount('codex', 'B', b);
    const id = settings.accounts.codex!.find(account => account.name === 'B')!.id;
    running = f.accounts.withEnv('codex', b, async env => {
      entered.resolve();
      await release.promise;
      await fs.writeFile(path.join(env['CODEX_HOME']!, 'auth.json'), codexRecord('B-refreshed'));
    });
    await entered.promise;
    const removed = await app.settings.removeAccount('codex', id);
    assert.equal(removed.accounts.codex!.some(account => account.id === id), false);
    assert.equal(f.accounts.hasStored('codex', b), false);
    await assert.rejects(f.accounts.import('codex', b), /Account credentials unavailable/);
    await assert.rejects(f.accounts.withEnv('codex', b, async () => assert.fail('removed lease must not be acquired')), /Account credentials unavailable/);
    release.resolve();
    await running;
    assert.equal(f.accounts.hasStored('codex', b), false);
    await fs.writeFile(file, codexRecord('B-new'));
    await app.settings.addAccount('codex', 'B readded', b);
    await f.accounts.withEnv('codex', b, async env => {
      assert.equal(await fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'), codexRecord('B-new'));
    });
  } finally { release.resolve(); await running?.catch(() => {}); app.close(); await f.cleanup(); }
});

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

test('the selected account and the default slot refresh one record, so neither copy is left with a rotated-away token', async () => {
  const f = await fixture();
  try {
    const [one, two] = [path.join(f.root, 'one'), path.join(f.root, 'two')];
    await f.source('codex', one, codexRecord('one'));
    await f.source('codex', two, codexRecord('two'));
    await f.accounts.import('codex', one);
    await f.accounts.import('codex', two);
    const refresh = (configDir: string | undefined, record: string) => f.accounts.withEnv('codex', configDir, async env => {
      const file = path.join(env['CODEX_HOME']!, 'auth.json');
      const seen = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, record);
      return seen;
    });
    const read = (configDir: string | undefined) => f.accounts.withEnv('codex', configDir, async env => fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'));
    await f.accounts.activate('codex', one);
    // A run in the slot refreshes; the account's own quota/MCP home sees that refresh, and its refresh reaches the slot.
    assert.equal(await refresh(undefined, codexRecord('one-run')), codexRecord('one'));
    assert.equal(await refresh(one, codexRecord('one-quota')), codexRecord('one-run'));
    assert.equal(await read(undefined), codexRecord('one-quota'));
    // Switching away hands the newest copy back; switching back returns it to the slot.
    await f.accounts.activate('codex', two);
    assert.equal(await read(undefined), codexRecord('two'));
    assert.equal(await read(one), codexRecord('one-quota'));
    await f.accounts.activate('codex', one);
    assert.equal(await read(undefined), codexRecord('one-quota'));
    // An undone switch also restores who holds the slot.
    const undo = await f.accounts.activate('codex', two);
    await undo();
    await refresh(one, codexRecord('one-after-undo'));
    assert.equal(await read(undefined), codexRecord('one-after-undo'));
    // Emptying the slot hands its copy back too.
    await f.accounts.remove('codex');
    assert.equal(await read(one), codexRecord('one-after-undo'));
    await assert.rejects(read(undefined), /Account credentials unavailable/);
  } finally { await f.cleanup(); }
});

test('linking at startup keeps the more recently refreshed of copies that already diverged', async () => {
  const f = await fixture();
  try {
    const one = path.join(f.root, 'one');
    const record = (name: string, at: string) => JSON.stringify({ ...JSON.parse(codexRecord(name)), last_refresh: at });
    await f.source('codex', one, record('older', '2026-10-01T00:00:00Z'));
    await f.accounts.import('codex', one);
    await f.accounts.activate('codex', one);
    const read = (configDir: string | undefined) => f.accounts.withEnv('codex', configDir, async env => fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'));
    // Copies refreshed apart before linking existed: after a restart the slot's newer copy wins.
    await f.accounts.withEnv('codex', undefined, async env => fs.writeFile(path.join(env['CODEX_HOME']!, 'auth.json'), record('slot', '2026-10-03T00:00:00Z')));
    await f.accounts.link('codex', undefined);
    await f.accounts.withEnv('codex', one, async env => fs.writeFile(path.join(env['CODEX_HOME']!, 'auth.json'), record('own', '2026-10-02T00:00:00Z')));
    await f.accounts.link('codex', one);
    assert.equal(await read(one), record('slot', '2026-10-03T00:00:00Z'));
    // The account's own copy wins when it is the newer one.
    await f.accounts.link('codex', undefined);
    await f.accounts.withEnv('codex', one, async env => fs.writeFile(path.join(env['CODEX_HOME']!, 'auth.json'), record('own', '2026-10-04T00:00:00Z')));
    await f.accounts.link('codex', one);
    assert.equal(await read(undefined), record('own', '2026-10-04T00:00:00Z'));
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

test('Grok quota renews expired credentials through its configured native command', async t => {
  const f = await fixture();
  try {
    const expired = grokRecord('stale').replace('2099-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    const renewed = grokRecord('renewed');
    const source = await f.source('grok', path.join(f.root, '.grok'), expired);
    await f.accounts.import('grok');
    const cli = path.join(f.root, 'renew.ts');
    await fs.writeFile(cli, `import fs from 'node:fs'; fs.writeFileSync(process.env.GROK_AUTH_PATH!, ${JSON.stringify(renewed)});`);
    const tokens: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      tokens.push((init.headers as Record<string, string>)['Authorization']!);
      return Response.json({ config: { creditUsagePercent: 30 } });
    });
    const provider = f.accounts.provider('grok', { ...DEFAULT_CONFIG.cli.grok, command: process.execPath, authRefreshArgs: [cli] });
    assert.equal((await provider.quota!())?.windows[0]?.usedPercent, 30);
    await fs.writeFile(cli, 'process.exit(3);');
    assert.equal((await provider.quota!())?.windows[0]?.usedPercent, 30);
    assert.deepEqual(tokens, ['Bearer renewed-token', 'Bearer renewed-token']);
    assert.equal(await fs.readFile(source, 'utf8'), expired);
    await f.accounts.import('grok', undefined, true);
    await assert.rejects(provider.quota!(), { message: 'Account credentials unavailable.' });
    await f.accounts.withEnv('grok', undefined, async env => {
      assert.equal(await fs.readFile(env['GROK_AUTH_PATH']!, 'utf8'), expired);
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

test('Claude quota shares one renewal across selected/default aliases and persists the rotated record', async t => {
  const f = await fixture();
  try {
    const home = path.join(f.root, 'selected');
    const original = JSON.stringify({ extension: 'retained', claudeAiOauth: { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1, scopes: ['user:profile'] } });
    const source = await f.source('claude', home, original);
    await f.accounts.import('claude', home);
    await f.accounts.activate('claude', home);
    let refreshes = 0;
    let queries = 0;
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/oauth/token')) {
        refreshes++;
        assert.equal(JSON.parse(String(init.body)).refresh_token, 'old-refresh');
        return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
      }
      queries++;
      assert.equal((init.headers as Record<string, string>)['Authorization'], 'Bearer new');
      return Response.json({ five_hour: { utilization: 27, resets_at: '2099-01-01T00:00:00Z' } });
    });
    const provider = f.accounts.provider('claude', { ...DEFAULT_CONFIG.cli.claude, command: process.execPath });
    const quotas = await Promise.all([provider.quota!(), provider.quota!(home)]);
    assert.deepEqual(quotas.map(quota => quota?.windows[0]?.usedPercent), [27, 27]);
    assert.equal(refreshes, 1);
    assert.equal(queries, 1);
    await f.accounts.withEnv('claude', home, async env => {
      const record = JSON.parse(await fs.readFile(path.join(env['CLAUDE_CONFIG_DIR']!, '.credentials.json'), 'utf8'));
      assert.equal(record.extension, 'retained');
      assert.equal(record.claudeAiOauth.refreshToken, 'rotated');
      assert.equal(record.claudeAiOauth.accessToken, 'new');
    });
    assert.equal((await provider.quota!())?.windows[0]?.usedPercent, 27);
    assert.equal(refreshes, 1);
    assert.equal(await fs.readFile(source, 'utf8'), original);
  } finally { await f.cleanup(); }
});

test('Claude quota refreshes a rejected token once, not on unrelated failures, and retains invalid-grant credentials', async t => {
  const f = await fixture();
  try {
    const original = JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 } });
    await f.source('claude', path.join(f.root, '.claude'), original);
    await f.accounts.import('claude');
    let status = 401;
    let refreshes = 0;
    let queries = 0;
    let invalid = false;
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url.endsWith('/oauth/token')) {
        refreshes++;
        return invalid ? Response.json({ error: 'invalid_grant' }, { status: 400 })
          : Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
      }
      queries++;
      return Response.json({}, { status });
    });
    const provider = f.accounts.provider('claude', { ...DEFAULT_CONFIG.cli.claude, command: process.execPath });
    await assert.rejects(provider.quota!(), QuotaAuthenticationRequired);
    assert.equal(refreshes, 1);
    assert.equal(queries, 2);
    status = 403;
    await assert.rejects(provider.quota!(), /Account credentials unavailable/);
    assert.equal(refreshes, 1);
    status = 401;
    invalid = true;
    await assert.rejects(provider.quota!(), QuotaAuthenticationRequired);
    assert.equal(refreshes, 2);
    await assert.rejects(provider.quota!(), QuotaAuthenticationRequired);
    assert.equal(refreshes, 2, 'a rejected refresh token is not submitted again');
    await f.accounts.withEnv('claude', undefined, async env => {
      const record = JSON.parse(await fs.readFile(path.join(env['CLAUDE_CONFIG_DIR']!, '.credentials.json'), 'utf8'));
      assert.equal(record.claudeAiOauth.accessToken, 'new');
      assert.equal(record.claudeAiOauth.refreshToken, 'rotated');
    });
    await f.source('claude', path.join(f.root, '.claude'), JSON.stringify({ claudeAiOauth: { accessToken: 'login', refreshToken: 'new-login-refresh', expiresAt: 1 } }));
    await f.accounts.import('claude', undefined, true);
    invalid = false;
    await assert.rejects(provider.quota!(), QuotaAuthenticationRequired);
    assert.equal(refreshes, 4, 'new login credentials may refresh again, with at most one usage retry');
  } finally { await f.cleanup(); }
});

test('linked native leases share refresh writes and prevent switching an account still in use', async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, 'selected');
    await f.source('codex', home, codexRecord('old'));
    await f.accounts.import('codex', home);
    await f.accounts.activate('codex', home);
    await f.accounts.withEnv('codex', home, async selected => {
      await f.accounts.withEnv('codex', undefined, async slot => {
        assert.equal(slot['CODEX_HOME'], selected['CODEX_HOME']);
        await fs.writeFile(path.join(slot['CODEX_HOME']!, 'auth.json'), codexRecord('rotated'));
      });
      assert.equal(await fs.readFile(path.join(selected['CODEX_HOME']!, 'auth.json'), 'utf8'), codexRecord('rotated'));
      await assert.rejects(f.accounts.activate('codex', home), /Account credentials unavailable/);
    });
    await f.accounts.withEnv('codex', undefined, async env => {
      assert.equal(await fs.readFile(path.join(env['CODEX_HOME']!, 'auth.json'), 'utf8'), codexRecord('rotated'));
    });
  } finally { await f.cleanup(); }
});

test('Gemini concurrent alias queries perform one native renewal and reuse its persisted token', async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, 'selected');
    await fs.mkdir(path.dirname(geminiToken(home)), { recursive: true });
    const original = geminiRecord('expired').replace('2030-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
    await fs.writeFile(geminiToken(home), original);
    await f.accounts.import('gemini', home);
    await f.accounts.activate('gemini', home);
    const marker = path.join(f.root, 'refresh-used');
    const cli = path.join(f.root, 'gemini-quota.ts');
    await fs.writeFile(cli, `import fs from 'node:fs'; import path from 'node:path';
const file = path.join(process.env.HOME!, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
if (record.token.access_token === 'expired') {
  fs.writeFileSync(${JSON.stringify(marker)}, 'rotated', { flag: 'wx' });
  record.token.access_token = 'fresh'; record.token.refresh_token = 'rotated';
  record.token.expiry = '2099-01-01T00:00:00Z';
  fs.writeFileSync(file, JSON.stringify(record));
}
if (record.token.access_token !== 'fresh' || process.env.SSH_TTY !== 'yumeewade-cli') process.exit(3);
console.log(JSON.stringify({status:'SUCCESS',command:{name:'usage',data:{groups:[{name:'Gemini',buckets:[{name:'Weekly',remaining_fraction:0.75,reset_time:'2099-01-01T00:00:00Z'}]}]}}}));
`);
    const provider = f.accounts.provider('gemini', { ...DEFAULT_CONFIG.cli.gemini, command: process.execPath, quotaArgs: [cli] });
    const quotas = await Promise.all([provider.quota!(), provider.quota!(home)]);
    assert.deepEqual(quotas.map(quota => quota?.windows[0]?.usedPercent), [25, 25]);
    assert.equal((await provider.quota!(home))?.windows[0]?.usedPercent, 25);
    await f.accounts.withEnv('gemini', undefined, async env => {
      const record = JSON.parse(await fs.readFile(geminiToken(env['HOME']!), 'utf8'));
      assert.equal(record.token.refresh_token, 'rotated');
    });
    assert.equal(await fs.readFile(geminiToken(home), 'utf8'), original);
  } finally { await f.cleanup(); }
});

test('Claude quota never rotates credentials concurrently with a native consumer', async t => {
  const f = await fixture();
  try {
    await f.source('claude', path.join(f.root, '.claude'), JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1 } }));
    await f.accounts.import('claude');
    t.mock.method(globalThis, 'fetch', async () => assert.fail('must not race native refresh'));
    const provider = f.accounts.provider('claude', { ...DEFAULT_CONFIG.cli.claude, command: process.execPath });
    await f.accounts.withEnv('claude', undefined, async env => {
      await assert.rejects(provider.quota!(), /Account credentials unavailable/);
      const file = path.join(env['CLAUDE_CONFIG_DIR']!, '.credentials.json');
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(record.claudeAiOauth.refreshToken, 'old-refresh');
    });
  } finally { await f.cleanup(); }
});
