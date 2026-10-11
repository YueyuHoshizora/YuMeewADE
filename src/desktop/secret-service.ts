import { app, safeStorage } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { isSecretRequest, MAX_CIPHERTEXT_BYTES, MAX_PLAINTEXT_BYTES, MAX_PENDING_SECRETS, SECRET_CHANNEL } from '../shared/secret-protocol.ts';
import type { SecretResponse } from '../shared/secret-protocol.ts';

// Share a logical identity; macOS access across builds still depends on code signing.
export function configureSecretApplication(): void {
  app.setName('YuMeewADE');
  const directory = path.join(app.getPath('appData'), 'yumeewade');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath('userData', directory);
}

export function createSecretRequestHandler(send: (message: SecretResponse) => void): (message: unknown) => void {
  let pending = 0;
  return (message: unknown): void => {
    if (!isSecretRequest(message)) return;
    if (pending >= MAX_PENDING_SECRETS) {
      send({ channel: SECRET_CHANNEL, id: message.id, ok: false, payload: '' });
      return;
    }
    pending++;
    void app.whenReady().then(() => {
      let payload: string;
      try {
        if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux'
          && !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend()))) throw new Error();
        switch (message.operation) {
          case 'ready': payload = app.getPath('userData'); break;
          case 'encrypt': {
            const encrypted = safeStorage.encryptString(message.payload);
            if (encrypted.length > MAX_CIPHERTEXT_BYTES) throw new Error();
            payload = encrypted.toString('base64');
            break;
          }
          case 'decrypt':
            payload = safeStorage.decryptString(Buffer.from(message.payload, 'base64'));
            if (Buffer.byteLength(payload, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error();
            break;
        }
        send({ channel: SECRET_CHANNEL, id: message.id, ok: true, payload });
      } catch {
        send({ channel: SECRET_CHANNEL, id: message.id, ok: false, payload: '' });
      }
    }).catch(() => {
      try { send({ channel: SECRET_CHANNEL, id: message.id, ok: false, payload: '' }); } catch { /* Parent exited. */ }
    }).finally(() => { pending--; });
  };
}
