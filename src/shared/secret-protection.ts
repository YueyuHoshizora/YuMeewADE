import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readFile } from 'node:fs/promises';
import { isSecretResponse, MAX_PENDING_SECRETS, MAX_PLAINTEXT_BYTES, SECRET_CHANNEL, SECRET_ERROR, SECRET_TIMEOUT_MS, validBase64 } from './secret-protocol.ts';
import type { SecretOperation, SecretRequest } from './secret-protocol.ts';

export interface SecretProtector {
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Uint8Array): Promise<string>;
  close(): Promise<void>;
}
interface ParentPort {
  on(event: 'message', listener: (message: { data: unknown }) => void): unknown;
  removeListener(event: 'message', listener: (message: { data: unknown }) => void): unknown;
  postMessage(message: SecretRequest): void;
}
const directories = new WeakMap<SecretProtector, string>();

/** The app-private directory reported by the OS-protection owner, never a workspace path. */
export function getSecretDataDirectory(protector: SecretProtector): string {
  const directory = directories.get(protector);
  if (!directory) throw new Error(SECRET_ERROR);
  return directory;
}

export async function createSecretProtector(): Promise<SecretProtector> {
  let child: ChildProcess | undefined;
  const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
  if (process.env['YUMEEWADE_SECRET_PARENT'] === '1' && !parent) throw new Error(SECRET_ERROR);
  if (!parent) {
    try {
      const electronDirectory = path.dirname(createRequire(import.meta.url).resolve('electron'));
      // Read the installed package's launcher metadata without executing its auto-downloader.
      const executableRelative = (await readFile(path.join(electronDirectory, 'path.txt'), 'utf8')).trim();
      if (!executableRelative || path.isAbsolute(executableRelative) || executableRelative.split(/[\\/]/).includes('..')) throw new Error();
      const executable = path.join(electronDirectory, 'dist', executableRelative);
      await access(executable);
      const helper = fileURLToPath(new URL('../desktop/secret-helper.js', import.meta.url));
      const env = { ...process.env };
      delete env['ELECTRON_RUN_AS_NODE'];
      delete env['YUMEEWADE_SECRET_PARENT'];
      child = spawn(executable, [helper], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    } catch { throw new Error(SECRET_ERROR); }
  }
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, { operation: SecretOperation; resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const cancel = (): void => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(SECRET_ERROR));
    }
    pending.clear();
  };
  const receive = (message: unknown): void => {
    if (!isSecretResponse(message)) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    const valid = message.ok && (entry.operation === 'encrypt' ? validBase64(message.payload)
      : entry.operation === 'ready' ? message.payload.length <= 8192 && path.isAbsolute(message.payload)
      : Buffer.byteLength(message.payload, 'utf8') <= MAX_PLAINTEXT_BYTES);
    if (valid) entry.resolve(message.payload);
    else entry.reject(new Error(SECRET_ERROR));
  };
  const receiveParent = (message: { data: unknown }): void => receive(message.data);
  parent?.on('message', receiveParent);
  child?.on('message', receive);
  child?.on('error', cancel);
  child?.on('exit', cancel);
  // Parent process termination must not leave a keychain helper behind.
  const exiting = (): void => { cancel(); child?.kill(); };
  process.once('exit', exiting);
  process.once('disconnect', cancel);
  const request = (operation: SecretOperation, payload: string): Promise<string> => {
    if (closed || pending.size >= MAX_PENDING_SECRETS || nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error(SECRET_ERROR));
    const id = nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cancel();
        child?.kill('SIGKILL');
      }, SECRET_TIMEOUT_MS);
      pending.set(id, { operation, resolve, reject, timer });
      const message: SecretRequest = { channel: SECRET_CHANNEL, id, operation, payload };
      try {
        if (parent) parent.postMessage(message);
        else if (child?.connected) child.send(message, error => { if (error) cancel(); });
        else cancel();
      } catch { cancel(); }
    });
  };
  let closePromise: Promise<void> | undefined;
  const protector: SecretProtector = {
    async encrypt(plaintext) {
      if (typeof plaintext !== 'string' || plaintext.length > MAX_PLAINTEXT_BYTES
        || Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error(SECRET_ERROR);
      return Buffer.from(await request('encrypt', plaintext), 'base64');
    },
    async decrypt(ciphertext) {
      if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength === 0 || ciphertext.byteLength > 2 * MAX_PLAINTEXT_BYTES) throw new Error(SECRET_ERROR);
      return request('decrypt', Buffer.from(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength).toString('base64'));
    },
    close() {
      if (closePromise) return closePromise;
      cancel();
      parent?.removeListener('message', receiveParent);
      process.removeListener('exit', exiting);
      process.removeListener('disconnect', cancel);
      const owned = child;
      closePromise = new Promise<void>(resolve => {
        if (!owned || owned.pid === undefined || owned.exitCode !== null || owned.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { owned.kill('SIGKILL'); }, 2000);
        owned.once('exit', () => { clearTimeout(timer); resolve(); });
        if (owned.connected) owned.disconnect();
        else owned.kill();
      });
      return closePromise;
    },
  };
  try {
    directories.set(protector, await request('ready', ''));
    return protector;
  } catch {
    await protector.close();
    throw new Error(SECRET_ERROR);
  }
}
