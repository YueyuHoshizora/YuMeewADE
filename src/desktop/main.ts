// Electron 主行程：只管視窗與生命週期，核心以 utilityProcess 另起（與 npm start 同一份 dist/server/main.js）。
// renderer 走與網頁版完全相同的 http://127.0.0.1:{port}，不另立協定（安全節 4）。

import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import { mkdirSync, promises as fs } from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostAuthority, loadConfig } from '../shared/config.ts';
import { probe, waitForCore } from './probe.ts';
import { acceptsFrame, validBadgeCount } from './policy.ts';
import { stopOwnedCore } from './shutdown.ts';
import { configureSecretApplication, createSecretRequestHandler } from './secret-service.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, '..', '..');
const SERVER_ENTRY = path.join(HERE, '..', 'server', 'main.js');
const PRELOAD = path.join(HERE, 'preload.cjs');
// Preserve existing packaged configuration while giving secrets one cross-mode identity.
const CONFIG_DIRECTORY = app.getPath('userData');

let core: UtilityProcess | null = null;
let quitting = false;
let shutdownComplete = false;
let mainWindow: BrowserWindow | null = null;
let coreOrigin = '';
mkdirSync(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });
app.setPath('sessionData', CONFIG_DIRECTORY);
configureSecretApplication();
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

function focusWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

app.on('second-instance', focusWindow);

/** 桌面版設定檔固定在使用者設定目錄；第一次啟動從範本複製。 */
async function ensureConfigPath(): Promise<string> {
  const fromEnv = process.env['YUMEEWADE_CONFIG'];
  if (fromEnv) return fromEnv;
  const file = path.join(CONFIG_DIRECTORY, 'config.yaml');
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
  if (quitting) return;
  core = utilityProcess.fork(SERVER_ENTRY, [], {
    env: { ...process.env, YUMEEWADE_SECRET_PARENT: '1' },
    stdio: 'pipe', serviceName: 'yumeewade-core',
  });
  const ownedCore = core;
  ownedCore.on('message', createSecretRequestHandler(message => ownedCore.postMessage(message)));
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
    minWidth: 640,
    minHeight: 480,
    title: 'YuMeewADE',
    ...(process.platform === 'darwin' ? {} : { icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(APP_ROOT, 'build', 'icon.png') }),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const origin = new URL(url).origin;
  coreOrigin = origin;
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
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

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  const ownedCore = core;
  if (!ownedCore) { quitting = true; return; }
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void stopOwnedCore(ownedCore).then(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());

if (primaryInstance) app
  .whenReady()
  .then(async () => {
    ipcMain.handle('pick-folder', async (event) => {
      const win = mainWindow;
      if (!win || event.sender !== win.webContents || !acceptsFrame(event.senderFrame?.url, coreOrigin)) return null;
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.on('set-badge', (event, count: unknown) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || !acceptsFrame(event.senderFrame?.url, coreOrigin) || !validBadgeCount(count)) return;
      if (process.platform !== 'win32') app.setBadgeCount(count);
    });
    ipcMain.on('focus-window', (event) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || !acceptsFrame(event.senderFrame?.url, coreOrigin)) return;
      focusWindow();
    });
    await ensureConfigPath();
    const config = await loadConfig();
    const { host, port } = config.server;
    if (quitting) return;
    await startCore(host, port);
    const url = `http://${hostAuthority(host, port)}/`;
    if (quitting) return;
    createWindow(url);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
    });
  })
  .catch((err: unknown) => {
    if (quitting) return;
    dialog.showErrorBox('YuMeewADE 無法啟動', err instanceof Error ? err.message : String(err));
    app.quit();
  });
