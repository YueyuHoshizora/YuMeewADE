import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SecretProtector } from '../shared/secret-protection.ts';
import { CredentialVault } from './vault.ts';

const failure = { message: 'Credential vault operation failed.' };
class TestProtector implements SecretProtector {
  closes = 0;
  async encrypt(plaintext: string): Promise<Buffer> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 42), nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }
  async decrypt(ciphertext: Uint8Array): Promise<string> {
    const bytes = Buffer.from(ciphertext);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 42), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  async close(): Promise<void> { this.closes++; }
}

async function temporary(): Promise<string> {
  // macOS temporary roots can be system symlink aliases; use the canonical directory.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'credential-vault-')));
}

test('vault persists default and added profiles separately, encrypts exact JSON, overwrites and removes', async () => {
  const root = await temporary();
  const protector = new TestProtector();
  let vault: CredentialVault | undefined;
  try {
    const directory = path.join(root, 'private', 'vault');
    vault = await CredentialVault.open(directory, protector);
    const first = ' { "token": "default-private-test-token", "escaped": "\\u0061" }\n';
    const second = '{"token":"second-private-test-token"}';
    await vault.write('claude', 'default', first);
    await vault.write('claude', 'second', second);
    await vault.write('codex', 'default', '{"token":"codex-private-test-token"}');
    assert.equal(await vault.read('claude', 'default'), first);
    assert.equal(await vault.read('claude', 'second'), second);
    assert.equal(await vault.read('codex', 'default'), '{"token":"codex-private-test-token"}');
    assert.equal(await vault.read('grok', 'default'), null);
    const inspection = new DatabaseSync(path.join(directory, 'credentials.sqlite'));
    try {
      const rows = inspection.prepare('SELECT ciphertext FROM credentials').all();
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.ok(row.ciphertext instanceof Uint8Array);
        assert.ok(!Buffer.from(row.ciphertext).includes(Buffer.from('private-test-token')));
      }
    } finally { inspection.close(); }
    for (const file of await fs.readdir(directory)) {
      assert.ok(!(await fs.readFile(path.join(directory, file))).includes(Buffer.from('private-test-token')));
    }
    await vault.write('claude', 'default', '{"token":"replacement"}');
    await vault.remove('claude', 'second');
    await vault.remove('claude', 'second');
    vault.close();
    vault.close();
    assert.equal(protector.closes, 0);
    vault = await CredentialVault.open(directory, protector);
    assert.equal(await vault.read('claude', 'default'), '{"token":"replacement"}');
    assert.equal(await vault.read('claude', 'second'), null);
    assert.equal(await vault.read('codex', 'default'), '{"token":"codex-private-test-token"}');
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(directory, 'credentials.sqlite'))).mode & 0o777, 0o600);
      await fs.chmod(directory, 0o755);
      await fs.chmod(path.join(directory, 'credentials.sqlite'), 0o644);
      vault.close();
      vault = await CredentialVault.open(directory, protector);
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(directory, 'credentials.sqlite'))).mode & 0o777, 0o600);
    }
  } finally { vault?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('vault fails closed when ciphertext is moved across a profile or provider, or corrupted', async () => {
  const root = await temporary();
  let vault: CredentialVault | undefined;
  const dbFile = path.join(root, 'credentials.sqlite');
  const protector = new TestProtector();
  try {
    vault = await CredentialVault.open(root, protector);
    await vault.write('claude', 'default', '{"token":"private-corruption-test"}');
    await vault.write('claude', 'second', '{}');
    await vault.write('codex', 'default', '{}');
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare("UPDATE credentials SET ciphertext = (SELECT ciphertext FROM credentials WHERE provider = 'claude' AND profile = 'default') WHERE profile = 'second' OR provider = 'codex'").run();
      await assert.rejects(vault.read('claude', 'second'), failure);
      await assert.rejects(vault.read('codex', 'default'), failure);
      db.prepare("UPDATE credentials SET ciphertext = ? WHERE provider = 'claude' AND profile = 'default'").run(Buffer.from('malformed-private-secret'));
      await assert.rejects(vault.read('claude', 'default'), failure);
      for (const envelope of ['null', '{bad-private-json', JSON.stringify({ version: 1, provider: 'claude', profile: 'default', credentialJson: 'private-not-json' }), JSON.stringify({ version: 2, provider: 'claude', profile: 'default', credentialJson: '{}' })]) {
        db.prepare("UPDATE credentials SET ciphertext = ? WHERE provider = 'claude' AND profile = 'default'").run(await protector.encrypt(envelope));
        await assert.rejects(vault.read('claude', 'default'), failure);
      }
    } finally { db.close(); }
  } finally { vault?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('vault bounds records, validates identity, sanitizes protector errors and rejects operations after close', async () => {
  const root = await temporary();
  const protector = new TestProtector();
  let vault: CredentialVault | undefined;
  try {
    vault = await CredentialVault.open(root, protector);
    for (const [provider, profile] of [['other', 'default'], ['claude', ''], ['claude', 'x'.repeat(4097)], ['claude', 'bad\0profile'], ['claude', '\ud800']]) {
      await assert.rejects(vault.write(provider!, profile!, '{}'), failure);
      await assert.rejects(vault.read(provider!, profile!), failure);
      await assert.rejects(vault.remove(provider!, profile!), failure);
    }
    for (const json of ['', '{private-invalid-json', JSON.stringify('x'.repeat(1024 * 1024))]) await assert.rejects(vault.write('grok', 'default', json), failure);
    await vault.write('grok', 'default', '{}');
    protector.encrypt = async () => { throw new Error('private-protector-secret'); };
    await assert.rejects(vault.write('grok', 'default', '{"new":true}'), failure);
    assert.equal(await vault.read('grok', 'default'), '{}');
    protector.decrypt = async () => { throw new Error('private-decrypt-secret'); };
    await assert.rejects(vault.read('grok', 'default'), failure);
    vault.close();
    await assert.rejects(vault.read('grok', 'missing'), failure);
    await assert.rejects(vault.write('grok', 'default', '{}'), failure);
    await assert.rejects(vault.remove('grok', 'default'), failure);
    assert.equal(protector.closes, 0);
  } finally { vault?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('vault rejects relative directories and symlink or hardlink database paths', { skip: process.platform === 'win32' }, async () => {
  const root = await temporary();
  const protector = new TestProtector();
  try {
    await assert.rejects(CredentialVault.open('relative-vault', protector), failure);
    const directory = path.join(root, 'private');
    await fs.mkdir(directory);
    const target = path.join(root, 'outside.sqlite');
    await fs.writeFile(target, 'not-a-database');
    await fs.symlink(target, path.join(directory, 'credentials.sqlite'));
    await assert.rejects(CredentialVault.open(directory, protector), failure);
    assert.equal(await fs.readFile(target, 'utf8'), 'not-a-database');
    await fs.unlink(path.join(directory, 'credentials.sqlite'));
    await fs.link(target, path.join(directory, 'credentials.sqlite'));
    await assert.rejects(CredentialVault.open(directory, protector), failure);
    await fs.unlink(path.join(directory, 'credentials.sqlite'));
    await fs.symlink(target, path.join(directory, 'credentials.sqlite-journal'));
    await assert.rejects(CredentialVault.open(directory, protector), failure);
    await fs.symlink(directory, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(CredentialVault.open(path.join(root, 'alias'), protector), failure);
    assert.equal(await fs.readFile(target, 'utf8'), 'not-a-database');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('closing during asynchronous protection never writes a partial record', async () => {
  const root = await temporary();
  const local = new TestProtector();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const protector: SecretProtector = {
    encrypt: async plaintext => { await gate; return local.encrypt(plaintext); },
    decrypt: ciphertext => local.decrypt(ciphertext),
    close: () => local.close(),
  };
  let vault: CredentialVault | undefined;
  try {
    vault = await CredentialVault.open(root, protector);
    const pending = vault.write('claude', 'default', '{}');
    vault.close();
    release();
    await assert.rejects(pending, failure);
    vault = await CredentialVault.open(root, local);
    assert.equal(await vault.read('claude', 'default'), null);
  } finally { release(); vault?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a vault created before Gemini is widened in place: rows survive, a private backup is kept, and Gemini can be stored', async () => {
  const root = await temporary();
  const protector = new TestProtector();
  try {
    const directory = path.join(root, 'vault');
    await fs.mkdir(directory, { mode: 0o700 });
    const file = path.join(directory, 'credentials.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE credentials (
      provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok')),
      profile TEXT NOT NULL,
      ciphertext BLOB NOT NULL CHECK(typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 1 AND ${16 * 1024 * 1024}),
      PRIMARY KEY (provider, profile)
    ) STRICT, WITHOUT ROWID;`);
    legacy.close();
    // Written through the real vault so the legacy row carries a valid envelope, then pushed back into the old schema.
    const seed = await CredentialVault.open(path.join(root, 'seed'), protector);
    await seed.write('codex', 'default', '{"old":true}');
    seed.close();
    const rows = new DatabaseSync(path.join(root, 'seed', 'credentials.sqlite')).prepare('SELECT provider, profile, ciphertext FROM credentials').all() as { provider: string; profile: string; ciphertext: Uint8Array }[];
    const old = new DatabaseSync(file);
    for (const row of rows) old.prepare('INSERT INTO credentials VALUES (?, ?, ?)').run(row.provider, row.profile, row.ciphertext);
    old.close();
    const vault = await CredentialVault.open(directory, protector);
    assert.equal(await vault.read('codex', 'default'), '{"old":true}');
    await vault.write('gemini', 'profile', '{"token":{}}');
    assert.equal(await vault.read('gemini', 'profile'), '{"token":{}}');
    vault.close();
    assert.ok((await fs.stat(`${file}.pre-gemini`)).isFile());
    if (process.platform !== 'win32') assert.equal((await fs.stat(`${file}.pre-gemini`)).mode & 0o077, 0);
    const again = await CredentialVault.open(directory, protector);
    assert.equal(await again.read('codex', 'default'), '{"old":true}');
    again.close();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
