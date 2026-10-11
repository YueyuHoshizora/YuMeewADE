import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import type { SecretProtector } from '../shared/secret-protection.ts';

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_ENVELOPE_BYTES = 8 * MAX_CREDENTIAL_BYTES;
const MAX_CIPHERTEXT_BYTES = 16 * MAX_CREDENTIAL_BYTES;
const FAILURE = 'Credential vault operation failed.';

function fail(): never { throw new Error(FAILURE); }

function identity(provider: string, profile: string): void {
  if (!['claude', 'codex', 'grok', 'gemini'].includes(provider)
    || typeof profile !== 'string' || !profile.length || !profile.isWellFormed() || Buffer.byteLength(profile) > 4096
    || profile.includes('\0')) fail();
}

function credential(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES) fail();
  JSON.parse(value);
}

function owned(uid: number): void {
  if (process.platform !== 'win32' && uid !== process.getuid?.()) fail();
}

async function privateDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || directory !== path.resolve(directory) || directory === path.parse(directory).root) fail();
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
  }
  const info = await fs.lstat(directory);
  owned(info.uid);
  // Windows relies on the per-user app directory's inherited ACL, not POSIX mode bits.
  await fs.chmod(directory, 0o700);
}

async function privateFile(file: string, create: boolean): Promise<void> {
  if (create) {
    try {
      const handle = await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.close();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  let info;
  try { info = await fs.lstat(file); }
  catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail();
  owned(info.uid);
  const handle = await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) fail();
    await handle.chmod(0o600);
  } finally { await handle.close(); }
}

function tableSql(name: string, ifNotExists: boolean): string {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
    provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok', 'gemini')),
    profile TEXT NOT NULL,
    ciphertext BLOB NOT NULL CHECK(typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 1 AND ${MAX_CIPHERTEXT_BYTES}),
    PRIMARY KEY (provider, profile)
  ) STRICT, WITHOUT ROWID;`;
}

/** An app-owned store; the injected OS protector remains owned by the caller. */
export class CredentialVault {
  private db: DatabaseSync | undefined;
  private readonly protector: SecretProtector;
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;
  private readonly deleteRecord: StatementSync;
  private readonly presence: StatementSync;

  private constructor(db: DatabaseSync, protector: SecretProtector) {
    this.db = db;
    this.protector = protector;
    this.select = db.prepare('SELECT ciphertext FROM credentials WHERE provider = ? AND profile = ?');
    this.upsert = db.prepare('INSERT INTO credentials (provider, profile, ciphertext) VALUES (?, ?, ?) ON CONFLICT(provider, profile) DO UPDATE SET ciphertext = excluded.ciphertext');
    this.deleteRecord = db.prepare('DELETE FROM credentials WHERE provider = ? AND profile = ?');
    this.presence = db.prepare('SELECT 1 FROM credentials WHERE provider = ? AND profile = ?');
  }

  static async open(directory: string, protector: SecretProtector): Promise<CredentialVault> {
    let db: DatabaseSync | undefined;
    try {
      await privateDirectory(directory);
      const file = path.join(directory, 'credentials.sqlite');
      await privateFile(file, true);
      for (const suffix of ['-journal', '-wal', '-shm']) await privateFile(file + suffix, false);
      db = new DatabaseSync(file, { timeout: 5000, allowExtension: false });
      // Only encrypted BLOBs enter SQLite, including rollback journals and freed pages.
      db.exec(`PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA trusted_schema = OFF;
        ${tableSql('credentials', true)}`);
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'credentials'").get() as { sql?: unknown } | undefined;
      if (typeof schema?.sql === 'string' && !schema.sql.includes("'gemini'")) {
        // Vaults created before Gemini restrict `provider`; keep a private copy of the encrypted rows, then widen the CHECK in one transaction.
        const backup = `${file}.pre-gemini`;
        await fs.copyFile(file, backup, constants.COPYFILE_EXCL).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        await privateFile(backup, false);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(`${tableSql('credentials_new', false)}
            INSERT INTO credentials_new (provider, profile, ciphertext) SELECT provider, profile, ciphertext FROM credentials;
            DROP TABLE credentials;
            ALTER TABLE credentials_new RENAME TO credentials;`);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      return new CredentialVault(db, protector);
    } catch {
      try { db?.close(); } catch { /* Preserve the sanitized error. */ }
      fail();
    }
  }

  private requireOpen(): void { if (!this.db) fail(); }

  /** Presence only; onboarding must not decrypt or expose credential contents. */
  has(provider: string, profile: string): boolean {
    identity(provider, profile);
    this.requireOpen();
    return !!this.presence.get(provider, profile);
  }

  async read(provider: string, profile: string): Promise<string | null> {
    try {
      identity(provider, profile);
      this.requireOpen();
      const row = this.select.get(provider, profile);
      if (!row) return null;
      if (!(row.ciphertext instanceof Uint8Array) || !row.ciphertext.byteLength || row.ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) fail();
      const plaintext = await this.protector.decrypt(row.ciphertext);
      this.requireOpen();
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_ENVELOPE_BYTES) fail();
      const envelope: unknown = JSON.parse(plaintext);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail();
      const record = envelope as Record<string, unknown>;
      if (record.version !== 1 || record.provider !== provider || record.profile !== profile) fail();
      credential(record.credentialJson);
      return record.credentialJson;
    } catch { fail(); }
  }

  async write(provider: string, profile: string, credentialJson: string): Promise<void> {
    try {
      identity(provider, profile);
      this.requireOpen();
      credential(credentialJson);
      const envelope = JSON.stringify({ version: 1, provider, profile, credentialJson });
      if (Buffer.byteLength(envelope) > MAX_ENVELOPE_BYTES) fail();
      const encrypted = await this.protector.encrypt(envelope);
      if (!(encrypted instanceof Uint8Array) || !encrypted.byteLength || encrypted.byteLength > MAX_CIPHERTEXT_BYTES) fail();
      this.requireOpen();
      this.upsert.run(provider, profile, encrypted);
    } catch { fail(); }
  }

  async remove(provider: string, profile: string): Promise<void> {
    try {
      identity(provider, profile);
      this.requireOpen();
      this.deleteRecord.run(provider, profile);
    } catch { fail(); }
  }

  close(): void {
    const db = this.db;
    this.db = undefined;
    try { db?.close(); } catch { fail(); }
  }
}
