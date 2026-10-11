// 僅由打包產物 smoke 啟用；沿用真實視窗、preload 與核心，不替換服務或憑證保護。
import { app, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function reportArtifactSmoke(win: BrowserWindow, directory: string, origin: string): Promise<void> {
  if (!app.isPackaged) throw new Error('Artifact smoke requires a packaged application');
  const result: unknown = await win.webContents.executeJavaScript(`(() => {
    const { promise, resolve, reject } = Promise.withResolvers();
    const deadline = Date.now() + 20000;
    const poll = () => {
      if (document.querySelector('#header .brand') && document.querySelector('#main')?.children.length
        && window.yumeewade && document.styleSheets.length > 0) {
        resolve({ origin: location.origin, title: document.title, preload: true, rendered: true });
      } else if (Date.now() >= deadline) reject(new Error('Packaged renderer did not initialize'));
      else setTimeout(poll, 100);
    };
    poll();
    return promise;
  })()`);
  if (!result || typeof result !== 'object' || !('origin' in result) || result.origin !== origin
    || !('preload' in result) || result.preload !== true || !('rendered' in result) || result.rendered !== true) throw new Error('Invalid packaged renderer report');
  const temporary = path.join(directory, 'renderer.json.tmp');
  await fs.writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, path.join(directory, 'renderer.json'));
}
