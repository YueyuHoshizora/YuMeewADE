// 先讓核心停止 AI 並落盤；無回應才強制結束，外部核心不傳入此函式。
export interface OwnedCore {
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
  postMessage(message: string): void;
  kill(): unknown;
}

export function stopOwnedCore(core: OwnedCore, timeoutMs = 8000): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    core.removeListener('exit', finish);
    resolve();
  };
  const force = (): void => {
    if (finished) return;
    try { core.kill(); } finally { finish(); }
  };
  const timer = setTimeout(force, timeoutMs);
  core.once('exit', finish);
  try { core.postMessage('shutdown'); } catch { force(); }
  return promise;
}
