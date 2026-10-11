import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecretRequest, isSecretResponse, MAX_CIPHERTEXT_BYTES, MAX_PLAINTEXT_BYTES, SECRET_CHANNEL, validBase64 } from './secret-protocol.ts';

test('private secret requests require exact schema and known operation', () => {
  const request = { channel: SECRET_CHANNEL, id: 1, operation: 'ready', payload: '' };
  assert.equal(isSecretRequest(request), true);
  for (const value of [null, [], 'shutdown', { ...request, id: 0 }, { ...request, id: 1.5 },
    { ...request, channel: 'pick-folder' }, { ...request, operation: 'close' },
    { ...request, payload: 'unexpected' }, { ...request, extra: true }]) {
    assert.equal(isSecretRequest(value), false);
  }
});

test('plaintext limits count UTF-8 bytes, not just characters', () => {
  const request = { channel: SECRET_CHANNEL, id: 1, operation: 'encrypt', payload: 'a'.repeat(MAX_PLAINTEXT_BYTES) };
  assert.equal(isSecretRequest(request), true);
  assert.equal(isSecretRequest({ ...request, payload: `${request.payload}a` }), false);
  assert.equal(isSecretRequest({ ...request, payload: '語'.repeat(Math.floor(MAX_PLAINTEXT_BYTES / 3) + 1) }), false);
});

test('ciphertext requires bounded padded base64', () => {
  assert.equal(validBase64(Buffer.alloc(MAX_CIPHERTEXT_BYTES).toString('base64')), true);
  assert.equal(validBase64(Buffer.alloc(MAX_CIPHERTEXT_BYTES + 1).toString('base64')), false);
  for (const payload of ['', '!', 'YQ', 'YQ===', 'Y Q=', '====']) {
    assert.equal(validBase64(payload), false);
    assert.equal(isSecretRequest({ channel: SECRET_CHANNEL, id: 1, operation: 'decrypt', payload }), false);
  }
});

test('failure responses never carry exception text or payloads', () => {
  const response = { channel: SECRET_CHANNEL, id: 1, ok: false, payload: '' };
  assert.equal(isSecretResponse(response), true);
  assert.equal(isSecretResponse({ ...response, payload: 'sensitive error' }), false);
  assert.equal(isSecretResponse({ ...response, error: 'sensitive error' }), false);
  assert.equal(isSecretResponse({ ...response, ok: 'false' }), false);
});
