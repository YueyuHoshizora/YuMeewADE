import { app, dialog, type BrowserWindow } from 'electron';
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { desktopText } from './messages.ts';

export function monitorRenderer(win: BrowserWindow, quitting: () => boolean): void {
  let prompting = false;
  const log = (reason: string, exitCode?: number): void => {
    try {
      const file = path.join(app.getPath('userData'), 'renderer-health.jsonl');
      if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, `${file}.previous`);
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), window: win.id, reason, exitCode })}\n`, { mode: 0o600 });
    } catch { console.error('無法保存 renderer 狀態日誌'); }
  };
  win.webContents.on('render-process-gone', (_event, details) => {
    if (quitting() || win.isDestroyed() || details.reason === 'clean-exit') return;
    log(details.reason, details.exitCode);
    if (prompting) return;
    prompting = true;
    const m = desktopText();
    void dialog.showMessageBox(win, { type: 'error', title: 'YuMeewADE', message: m.rendererGone, buttons: [m.reload, m.quit], defaultId: 0, cancelId: 1 }).then(({ response }) => {
      if (quitting() || win.isDestroyed()) return;
      if (response === 0) win.reload(); else app.quit();
    }).finally(() => { prompting = false; });
  });
  win.on('unresponsive', () => {
    if (quitting() || prompting || win.isDestroyed()) return;
    log('unresponsive'); prompting = true;
    const m = desktopText();
    void dialog.showMessageBox(win, { type: 'warning', title: 'YuMeewADE', message: m.rendererUnresponsive, buttons: [m.wait, m.reload], defaultId: 0, cancelId: 0 }).then(({ response }) => {
      if (response === 1 && !quitting() && !win.isDestroyed()) win.reload();
    }).finally(() => { prompting = false; });
  });
}
