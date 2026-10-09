// Electron 主行程：只管視窗與生命週期，核心以 utilityProcess 另起（與 npm start 同一份 dist/server/main.js）。
// renderer 走與網頁版完全相同的 http://127.0.0.1:{port}，不另立協定（安全節 4）。

import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import { promises as fs } from 'node:fs';

import path from 'node:path';
import { loadConfig } from '../shared/config.ts';
import { probe, waitForCore } from './probe.ts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP_ROOT = path.join(HERE, '..', '..');
const SERVER_ENTRY = path.join(HERE, '..', 'server', 'main.js');
const PRELOAD = path.join(HERE, 'preload.cjs');

let core: UtilityProcess | null = null;
let quitting = false;

/** 桌面版設定檔固定在使用者設定目錄；第一次啟動從範本複製。 */
async function ensureConfigPath(): Promise<string> {
  const fromEnv = process.env['YUMEEWADE_CONFIG'];
  if (fromEnv) return fromEnv;
  const file = path.join(app.getPath('userData'), 'config.yaml');
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(path.join(APP_ROOT, 'config.yaml'), file);
  }
  process.env['YUMEEWADE_CONFIG'] = file;
  return file;
}

async function startCore(host: string, port: number): Promise<void> {
  if (await probe(host, port)) return; // 已有核心在跑，直接用
  core = utilityProcess.fork(SERVER_ENTRY, [], { env: { ...process.env }, stdio: 'pipe', serviceName: 'yumeewade-core' });
  core.stdout?.on('data', (c: Buffer) => process.stdout.write(c));
  core.stderr?.on('data', (c: Buffer) => process.stderr.write(c));
  core.on('exit', (code) => {
    core = null;
    if (code !== 0 && !quitting) {
      dialog.showErrorBox('YuMeewADE', `核心程序結束（代碼 ${code}）。請檢查設定檔與日誌。`);
      app.quit();
    }
  });
  const result = await waitForCore(host, port, { timeoutMs: 15_000, intervalMs: 250, alive: () => core !== null });
  if (result === 'dead') throw new Error('核心啟動失敗');
  if (result === 'timeout') throw new Error('核心啟動逾時');
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'YuMeewADE',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const origin = new URL(url).origin;
  win.webContents.on('will-navigate', (ev, target) => {
    if (new URL(target).origin !== origin) {
      ev.preventDefault();
      if (/^https?:/.test(target)) void shell.openExternal(target);
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  void win.loadURL(url);
  return win;
}

app.on('before-quit', () => {
  quitting = true;
  core?.kill();
});

app.on('window-all-closed', () => app.quit());

app
  .whenReady()
  .then(async () => {
    ipcMain.handle('pick-folder', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      // 僅由我們的 renderer 呼叫；不向任意遠端 frame 暴露原生對話框。
      const url = new URL(event.senderFrame?.url ?? 'about:blank');
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    await ensureConfigPath();
    const config = await loadConfig();
    const { host, port } = config.server;
    await startCore(host, port);
    const url = `http://${host}:${port}/`;
    createWindow(url);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
    });
  })
  .catch((err: unknown) => {
    dialog.showErrorBox('YuMeewADE 無法啟動', err instanceof Error ? err.message : String(err));
    app.quit();
  });
