import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { withFileLocks } from './fsx.ts';

test('同一絕對路徑 FIFO，失敗釋放，不同路徑可同時執行', async () => {
  const file = path.resolve('lock-test-a');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const first = withFileLocks([file], async () => { events.push('first'); await gate; throw new Error('failed'); });
  const failed = assert.rejects(first, /failed/);
  const second = withFileLocks([path.join(path.dirname(file), '.', path.basename(file))], async () => { events.push('second'); return 2; });
  await withFileLocks([path.resolve('lock-test-b')], async () => { events.push('independent'); });
  assert.deepEqual(events, ['first', 'independent']);
  release();
  await failed;
  assert.equal(await second, 2);
  assert.deepEqual(events, ['first', 'independent', 'second']);
  assert.equal(await withFileLocks([file], async () => 3), 3);
});

test('反向多檔與重複路徑不會死鎖', async () => {
  const a = path.resolve('lock-test-multi-a'), b = path.resolve('lock-test-multi-b');
  const events: number[] = [];
  await Promise.all([
    withFileLocks([a, b, a], async () => { events.push(1); await Promise.resolve(); events.push(2); }),
    withFileLocks([b, a], async () => { events.push(3); }),
  ]);
  assert.deepEqual(events, [1, 2, 3]);
});
