// Private process IPC only; never register this protocol with renderer IPC.
export const SECRET_CHANNEL = 'yumeewade-secret-v1';
export const MAX_PLAINTEXT_BYTES = 1024 * 1024;
export const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024;
export const MAX_PENDING_SECRETS = 32;
export const SECRET_TIMEOUT_MS = 15_000;
export const SECRET_ERROR = 'OS credential protection unavailable';
export type SecretOperation = 'ready' | 'encrypt' | 'decrypt';
export interface SecretRequest { channel: typeof SECRET_CHANNEL; id: number; operation: SecretOperation; payload: string }
export interface SecretResponse { channel: typeof SECRET_CHANNEL; id: number; ok: boolean; payload: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validBase64(value: string): boolean {
  return value.length > 0 && value.length <= Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    && Buffer.byteLength(value, 'base64') <= MAX_CIPHERTEXT_BYTES;
}
export function isSecretRequest(value: unknown): value is SecretRequest {
  if (!record(value) || Object.keys(value).length !== 4 || value['channel'] !== SECRET_CHANNEL
    || !Number.isSafeInteger(value['id']) || (value['id'] as number) < 1 || typeof value['payload'] !== 'string') return false;
  switch (value['operation']) {
    case 'ready': return value['payload'] === '';
    case 'encrypt': return value['payload'].length <= MAX_PLAINTEXT_BYTES && Buffer.byteLength(value['payload'], 'utf8') <= MAX_PLAINTEXT_BYTES;
    case 'decrypt': return validBase64(value['payload']);
    default: return false;
  }
}
export function isSecretResponse(value: unknown): value is SecretResponse {
  return record(value) && Object.keys(value).length === 4 && value['channel'] === SECRET_CHANNEL
    && Number.isSafeInteger(value['id']) && (value['id'] as number) >= 1 && typeof value['ok'] === 'boolean'
    && typeof value['payload'] === 'string' && value['payload'].length <= Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4
    && (value['ok'] || value['payload'] === '');
}
