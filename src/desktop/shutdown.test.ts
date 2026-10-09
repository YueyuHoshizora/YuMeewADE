import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stopOwnedCore } from './shutdown.ts';

class TestCore extends EventEmitter {
  messages: string[] = [];
  killed = false;
  postMessage(message: string): void { this.messages.push(message); }
  kill(): void { this.killed = true; }
}

test('核心結束前持續等待，正常退出不強制中斷', async () => {
  const core = new TestCore();
  let completed = false;
  const stopped = stopOwnedCore(core, 1000).then(() => { completed = true; });
  await Promise.resolve();
  assert.deepEqual(core.messages, ['shutdown']);
  assert.equal(completed, false);
  assert.equal(core.killed, false);
  core.emit('exit');
  await stopped;
  assert.equal(completed, true);
  assert.equal(core.killed, false);
  assert.equal(core.listenerCount('exit'), 0);
});

test('核心無回應時有界結束等待並強制停止', async () => {
  const core = new TestCore();
  await stopOwnedCore(core, 10);
  assert.deepEqual(core.messages, ['shutdown']);
  assert.equal(core.killed, true);
  assert.equal(core.listenerCount('exit'), 0);
});

test('傳送關閉訊息失敗仍能結束', async () => {
  const core = new TestCore();
  core.postMessage = () => { throw new Error('closed channel'); };
  await stopOwnedCore(core, 1000);
  assert.equal(core.killed, true);
  assert.equal(core.listenerCount('exit'), 0);
});
