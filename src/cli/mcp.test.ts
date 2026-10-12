import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CredentialAccounts } from './accounts.ts';
import { CredentialVault } from '../credentials/vault.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { addMcp, listMcp, parseMcpList, removeMcp, validateMcpInput } from './mcp.ts';

test('MCP parsing returns only allowlisted metadata, not env, headers, arguments or URL credentials', () => {
  const rows = parseMcpList(JSON.stringify([{ name: 'remote', enabled: false, transport: { type: 'streamable_http', url: 'https://user:password@example.com/mcp?token=secret', http_headers: { Authorization: 'secret' } }, env: { KEY: 'secret' } }, { name: 'local', transport: { type: 'stdio', command: 'node', args: ['secret'], env: { KEY: 'secret' } } }]));
  assert.equal(rows[0]?.url, 'https://example.com/mcp'); assert.equal(rows[0]?.status, 'disabled');
  assert.equal(rows[1]?.command, 'node'); assert.ok(!JSON.stringify(rows).includes('secret'));
  assert.deepEqual(rows[0]?.envKeys, ['KEY']); assert.deepEqual(rows[0]?.headerKeys, ['Authorization']);
  assert.deepEqual(rows[1]?.envKeys, ['KEY']); assert.deepEqual(rows[1]?.headerKeys, []);
  assert.deepEqual(parseMcpList('Checking MCP server health...\nlocal: node private-argument - ✓ Connected\nremote: https://example.com/mcp?token=secret (HTTP) - ✗ Failed to connect').map(s => s.status), ['connected', 'failed']);
  assert.deepEqual(parseMcpList('No MCP servers configured.'), []);
  assert.throws(() => parseMcpList('unexpected output containing private-secret'), error => !String(error).includes('private-secret'));
});

test('MCP validates strict fields, bounded sizes and transport-specific values without echoing input', () => {
  assert.deepEqual(validateMcpInput({ name: 'one', transport: 'stdio', command: 'node', args: ['--flag', 'value'], env: { KEY: 'secret' } }).args, ['--flag', 'value']);
  for (const input of [
    { name: '-bad', transport: 'stdio', command: 'node' },
    { name: 'one', transport: 'stdio', command: '--flag' },
    { name: 'one', transport: 'stdio', command: 'node', args: Array(129).fill('x') },
    { name: 'one', transport: 'stdio', command: 'node', env: { BAD: 'private-secret\n' } },
    { name: 'one', transport: 'http', url: 'file:///private-secret' },
    { name: 'one', transport: 'http', url: 'https://user:private-secret@example.com' },
    { name: 'one', transport: 'http', url: 'https://example.com', headers: { 'Invalid Header': 'private-secret' } },
    { name: 'one', transport: 'http', url: 'https://example.com', args: [] },
    { name: 'one', transport: 'stdio', command: 'node', extra: 'private-secret' },
  ]) assert.throws(() => validateMcpInput(input), error => !String(error).includes('private-secret'));
});

test('fake CLI mutations persist across leases, isolate accounts and sanitize failures', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ym-mcp-test-')));
  const vault = await CredentialVault.open(path.join(root, 'vault'), { encrypt: async text => Buffer.from(text), decrypt: async bytes => Buffer.from(bytes).toString('utf8'), close: async () => {} });
  const accounts = new CredentialAccounts(vault, path.join(root, 'data'), []);
  try {
    const command = path.join(root, 'fake-cli');
    await fs.writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),home=process.env.CODEX_HOME,file=path.join(home,'mcp.json');if(args[0]==='--help'){console.log('Commands: mcp');process.exit(0)}let rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];if(args[1]==='list'){console.log(JSON.stringify(rows));process.exit(0)}if(args[1]==='add'){const name=args.find((v,i)=>i>1&&!v.startsWith('-')&&args[i-1]!=='--env');if(name==='fail'){console.error('private-secret');process.exit(1)}const at=args.indexOf('--');rows.push({name,transport:{type:'stdio',command:args[at+1],args:args.slice(at+2),env:{KEY:'private-secret'}}})}if(args[1]==='remove')rows=rows.filter(r=>r.name!==args[2]);fs.writeFileSync(file,JSON.stringify(rows));console.log('private-secret');\n`, { mode: 0o700 });
    const config = { ...DEFAULT_CONFIG.cli.codex, command };
    const profiles = [path.join(root, 'a'), path.join(root, 'b')];
    for (const directory of profiles) { await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'account-secret' })); await accounts.import('codex', directory); }
    let home = '';
    await accounts.withEnv('codex', profiles[0], async env => { home = env['CODEX_HOME']!; await addMcp('codex', config, env, { name: 'one', transport: 'stdio', command: 'node', args: ['private-secret'], env: { KEY: 'private-secret' } }); });
    await accounts.withEnv('codex', profiles[0], async env => { assert.equal(env['CODEX_HOME'], home); const result = await listMcp('codex', config, env); assert.equal(result.servers[0]?.name, 'one'); assert.ok(!JSON.stringify(result).includes('private-secret')); await assert.rejects(addMcp('codex', config, env, { name: 'one', transport: 'stdio', command: 'node' })); await assert.rejects(addMcp('codex', config, env, { name: 'fail', transport: 'stdio', command: 'node' }), error => !String(error).includes('private-secret')); });
    await accounts.withEnv('codex', profiles[1], async env => { assert.notEqual(env['CODEX_HOME'], home); assert.deepEqual((await listMcp('codex', config, env)).servers, []); });
    assert.equal(await fs.stat(path.join(profiles[0]!, 'mcp.json')).catch(() => null), null);
    await accounts.withEnv('codex', profiles[0], env => removeMcp('codex', config, env, 'one'));
    await accounts.withEnv('codex', profiles[0], async env => assert.deepEqual((await listMcp('codex', config, env)).servers, []));
  } finally { await accounts.close(); vault.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Claude add keeps the server name out of its variadic --env/--header flags', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ym-mcp-claude-')));
  try {
    const home = path.join(root, 'home'); await fs.mkdir(home);
    // Commander-style parsing like Claude Code: --env/--header take every following non-option value; `--` ends options.
    const command = path.join(root, 'claude');
    await fs.writeFile(command, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),file=path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json');
if(args[0]==='--help'){console.log('Commands: mcp');process.exit(0)}
const doc=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{mcpServers:{}};
if(args[1]==='list'){console.log('');process.exit(0)}
if(args[1]!=='add')process.exit(2);
const positional=[],env=[],headers=[];let i=2;
for(;i<args.length;i++){const a=args[i];if(a==='--'){i++;break}
if(a==='--scope'||a==='--transport'){i++;continue}
if(a==='--env'||a==='--header'){const into=a==='--env'?env:headers;while(i+1<args.length&&!args[i+1].startsWith('-'))into.push(args[++i]);continue}
positional.push(a)}
positional.push(...args.slice(i));
if(env.some(v=>!v.includes('='))){console.error('Invalid environment variable format');process.exit(1)}
if(positional.length<2){console.error("error: missing required argument 'name'");process.exit(1)}
doc.mcpServers[positional[0]]={target:positional[1],args:positional.slice(2),env,headers};fs.writeFileSync(file,JSON.stringify(doc));
`, { mode: 0o755 });
    const config = { ...DEFAULT_CONFIG.cli.claude, command };
    const env = { PATH: process.env['PATH'], HOME: home, CLAUDE_CONFIG_DIR: home };
    await addMcp('claude', config, env, { name: 'web', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
    await addMcp('claude', config, env, { name: 'local', transport: 'stdio', command: 'node', args: ['server.js'], env: { KEY: 'v' } });
    const servers = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).mcpServers;
    assert.deepEqual(servers.web, { target: 'https://example.com/mcp', args: [], env: [], headers: ['Authorization: Bearer x'] });
    assert.deepEqual(servers.local, { target: 'node', args: ['server.js'], env: ['KEY=v'], headers: [] });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Claude MCP list/add/remove preserve malformed config bytes before launching the native CLI', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ym-mcp-claude-malformed-')));
  try {
    const home = path.join(root, 'home'); const bin = path.join(root, 'bin');
    await fs.mkdir(home); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'),'{"migration":"clobbered","mcpServers":{}}');
console.log(process.argv[2]==='--help'?'Commands: mcp':'');
`, { mode: 0o755 });
    const config = { ...DEFAULT_CONFIG.cli.claude, command: 'claude' };
    const env = { PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: home, CLAUDE_CONFIG_DIR: home };
    const file = path.join(home, '.claude.json');
    const operations = {
      list: () => listMcp('claude', config, env),
      add: () => addMcp('claude', config, env, { name: 'one', transport: 'stdio', command: 'node' }),
      remove: () => removeMcp('claude', config, env, 'one'),
    };
    for (const [label, original] of Object.entries({
      truncated: '{"mcpServers":{"private-server":{"command":"node"}}',
      array: '[]',
      null: 'null',
      string: '"private-config"',
      invalidServers: '{"mcpServers":[]}',
      oversized: `{"padding":"${'x'.repeat(1048576)}"}`,
    })) {
      for (const [operation, run] of Object.entries(operations)) await t.test(`${operation} refuses ${label} without clobbering config`, async () => {
        await fs.writeFile(file, original);
        const error = await run().then(() => undefined, error => error);
        assert.ok((await fs.readFile(file)).equals(Buffer.from(original)), 'native CLI must not replace malformed config');
        assert.equal(error?.code, 'unavailable');
      });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
