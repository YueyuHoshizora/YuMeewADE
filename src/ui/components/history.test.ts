import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoryWindow } from './history.ts';
import type { ChatRow } from '../../shared/types.ts';

const entry: ChatRow = { role: 'event', text: 'event', at: '2026-10-11', request: 'r' };
test('prepending preserves live rows and absolute positions', () => {
  const history = new HistoryWindow();
  history.reset({ start: 2, rows: [entry] });
  const revision = history.revision;
  history.rows.push({ ...entry, text: 'live' });
  assert.equal(history.prepend({ start: 0, rows: [entry, entry] }, 2, revision), true);
  assert.equal(history.start, 0);
  assert.deepEqual(history.rows.map(row => row.text), ['event', 'event', 'event', 'live']);
  assert.equal(history.prepend({ start: 0, rows: [entry, entry] }, 2, revision), false);
});
test('reconnect discards stale pages even with the same start', () => {
  const history = new HistoryWindow();
  history.reset({ start: 2, rows: [entry] });
  const revision = history.revision;
  history.reset({ start: 2, rows: [{ ...entry, text: 'snapshot' }] });
  assert.equal(history.prepend({ start: 0, rows: [entry, entry] }, 2, revision), false);
  assert.equal(history.prepend({ start: 1, rows: [] }, 2, history.revision), false);
  assert.deepEqual(history.rows.map(row => row.text), ['snapshot']);
});
