import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsFrame, grantsPermission, validBadgeCount } from './policy.ts';

test('原生橋接只接受核心同源 frame', () => {
  const origin = 'http://127.0.0.1:4270';
  assert.equal(acceptsFrame(`${origin}/chat`, origin), true);
  for (const url of [undefined, 'not a URL', 'about:blank', 'http://127.0.0.1:4271/', 'http://localhost:4270/', 'https://127.0.0.1:4270/', 'https://example.com/']) {
    assert.equal(acceptsFrame(url, origin), false);
  }
  assert.equal(acceptsFrame('about:blank', ''), false);
});

test('只有核心同源的頂層頁面取得通知與剪貼簿寫入權限', () => {
  const origin = 'http://127.0.0.1:4270';
  for (const permission of ['notifications', 'clipboard-sanitized-write']) assert.equal(grantsPermission(permission, true, `${origin}/`, origin), true);
  for (const permission of ['local-fonts', 'clipboard-read', 'media', 'geolocation']) assert.equal(grantsPermission(permission, true, `${origin}/`, origin), false);
  assert.equal(grantsPermission('notifications', false, `${origin}/`, origin), false);
  assert.equal(grantsPermission('notifications', true, 'http://127.0.0.1:5173/', origin), false);
});

test('徽章只接受範圍內整數，零可清除徽章', () => {
  for (const count of [0, 1, 9999]) assert.equal(validBadgeCount(count), true);
  for (const count of [-1, 10000, 0.5, NaN, Infinity, '1', null, undefined]) assert.equal(validBadgeCount(count), false);
});
