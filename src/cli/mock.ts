// MockCliProvider：不需任何 CLI 即可走完整個對話流程。
// 行為：發 session → 逐段串流「已收到：<指示最後一行>」→ result。
// 提示含 [slow] 時每段間隔拉長（測停止）；含 [fail] 時中途回 error 並非 0 結束。

import type { CliEvent, CliProvider, CliRun, RunOutcome, SendOptions } from './provider.ts';

export class MockCliProvider implements CliProvider {
  readonly name = 'mock';
  readonly dangerous = false;
  private readonly chunkMs: number;
  private counter = 0;

  constructor(chunkMs = 40) {
    this.chunkMs = chunkMs;
  }

  async available(): Promise<boolean> {
    return true;
  }

  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun {
    const { promise, resolve } = Promise.withResolvers<RunOutcome>();
    const userLine = opts.prompt.trimEnd().split('\n').at(-1) ?? '';
    const resumed = opts.resumeId ? `（續聊 ${opts.resumeId}）` : '';
    const reply = `已收到：${userLine}${resumed}${opts.model ? `［模型 ${opts.model}］` : ''}`;
    const slow = opts.prompt.includes('[slow]');
    const fail = opts.prompt.includes('[fail]');
    const pieces = reply.match(/.{1,6}/gsu) ?? [reply];
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let i = 0;
    const sessionId = opts.resumeId ?? `mock-${++this.counter}-${Date.now().toString(36)}`;
    onEvent({ type: 'session', id: sessionId });

    const step = () => {
      if (stopped) return;
      if (fail && i === Math.floor(pieces.length / 2)) {
        onEvent({ type: 'error', reason: 'mock 模擬失敗' });
        resolve({ ok: false, stopped: false, reason: 'mock 模擬失敗' });
        return;
      }
      if (i < pieces.length) {
        onEvent({ type: 'delta', text: pieces[i] as string });
        i++;
        timer = setTimeout(step, slow ? this.chunkMs * 25 : this.chunkMs);
        return;
      }
      onEvent({ type: 'result', text: reply });
      resolve({ ok: true, stopped: false });
    };
    timer = setTimeout(step, this.chunkMs);

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        resolve({ ok: false, stopped: true });
      },
      done: promise,
    };
  }
}
