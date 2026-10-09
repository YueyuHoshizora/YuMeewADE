import test from 'node:test';
import assert from 'node:assert/strict';
import { runLineProcess, captureCommand } from './process.ts';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('停止會終止持有 stdout 的孫行程並及時完成', { skip: process.platform === 'win32', timeout: 8000 }, async () => {
  let pid = 0;
  const run = runLineProcess({ command: '/bin/sh', args: ['-c', 'sleep 300 & p=$!; printf "{\\"pid\\":%s}\\n" "$p"; wait'], cwd: process.cwd(), env: process.env, prompt: '', label: 'test' }, (row) => { pid = Number(row['pid']); });
  for (let i = 0; i < 100 && !pid; i++) await delay(10);
  assert.ok(pid > 0);
  run.stop();
  assert.equal((await run.done).stopped, true);
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (err) { assert.equal((err as NodeJS.ErrnoException).code, 'ESRCH'); return; }
    await delay(10);
  }
  assert.fail('孫行程仍存活');
});

test('非推論指令逾時也會停止整個行程樹', { skip: process.platform === 'win32', timeout: 8000 }, async () => {
  const result = await captureCommand({ command: '/bin/sh', args: ['-c', 'sleep 300 & wait'], timeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'command timeout');
});

test('沒有換行的超大輸出會失敗而不是無限制累積', { timeout: 8000 }, async () => {
  const run = runLineProcess({ command: process.execPath, args: ['-e', 'process.stdout.write(\"x\".repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, prompt: '', label: 'limit-test' }, () => assert.fail('不應解析為 JSON'));
  const outcome = await run.done;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopped, false);
  assert.equal(outcome.reason, 'CLI line output limit exceeded');
});
