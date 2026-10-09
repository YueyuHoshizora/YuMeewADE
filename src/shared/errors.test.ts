import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zhTW } from '../ui/i18n/zh-TW.ts';
import { AppError, DETAIL_MESSAGES } from './errors.ts';

test('AppError：detail 轉繁中訊息並帶 {field}；toJSON 只含可對外欄位', () => {
  const e = new AppError('bad_request', 'field_required', { field: 'title', cause: new Error('secret path /x') });
  assert.equal(e.status, 400);
  assert.equal(e.publicMessage, 'title 必填');
  assert.deepEqual(e.toJSON(), { error: 'bad_request', message: 'title 必填', detail: 'field_required', field: 'title' });
  assert.deepEqual(new AppError('internal').toJSON(), { error: 'internal', message: '內部錯誤' });
  assert.ok(!JSON.stringify(e.toJSON()).includes('secret'));
});

test('每個 detail 代碼在七種語言都有翻譯（其他語言由 Record<MessageKey> 型別保證）', () => {
  for (const k of Object.keys(DETAIL_MESSAGES)) assert.ok(`detail.${k}` in zhTW, k);
});
