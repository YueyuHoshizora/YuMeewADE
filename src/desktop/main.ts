// Electron 主行程：只管視窗與生命週期，核心以 utilityProcess 另起（與 npm start 同一份 dist/server/main.js）。
// renderer 走與網頁版完全相同的 http://127.0.0.1:{port}，不另立協定（安全節 4）。

import { app, BrowserWindow, dialog, ipcMain, screen, shell, utilityProcess, type UtilityProcess } from 'electron';
import { mkdirSync, promises as fs } from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostAuthority, loadConfig } from '../shared/config.ts';
import { probe, waitForCore } from './probe.ts';
import { acceptsFrame, validBadgeCount } from './policy.ts';
import { stopOwnedCore } from './shutdown.ts';
import { configureSecretApplication, createSecretRequestHandler } from './secret-service.ts';
import { reportArtifactSmoke } from './artifact-smoke.ts';
import { WindowStateStore } from './window-state.ts';
import { installMenu } from './menu.ts';
import { createTray } from './tray.ts';
import { monitorRenderer } from './renderer-health.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, '..', '..');
const SERVER_ENTRY = path.join(HERE, '..', 'server', 'main.js');
const PRELOAD = path.join(HERE, 'preload.cjs');
// CI 只能對實際打包產物啟用；所有應用程式資料都留在腳本建立的暫存目錄。
const artifactSmoke = process.env['YUMEEWADE_ARTIFACT_SMOKE'];
if (artifactSmoke) {
  if (!app.isPackaged || !path.isAbsolute(artifactSmoke)) throw new Error('Invalid artifact smoke environment');
  const profile = path.join(artifactSmoke, 'profile');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('appData', profile);
  app.setPath('userData', path.join(profile, 'config'));
}
// Preserve existing packaged configuration while giving secrets one cross-mode identity.
const CONFIG_DIRECTORY = app.getPath('userData');

let core: UtilityProcess | null = null;
let quitting = false;
let shutdownComplete = false;
let mainWindow: BrowserWindow | null = null;
const windowSlots = new Map<BrowserWindow, number>();
let coreOrigin = '';
let disposeTray: (() => void) | undefined;
mkdirSync(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });
app.setPath('sessionData', CONFIG_DIRECTORY);
const windowStates = new WindowStateStore(path.join(app.getPath('appData'), 'yumeewade', 'window-state.json'));
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
  if (await probe(host, port)) {
    if (artifactSmoke) throw new Error('Artifact smoke cannot reuse an existing core');
    return; // 已有核心在跑，直接用
  }
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
  if (windowSlots.size >= 32 && mainWindow) { focusWindow(); return mainWindow; }
  const occupied = new Set(windowSlots.values());
  let slot = 0;
  while (occupied.has(slot)) slot++;
  const saved = windowStates.get(slot, [screen.getPrimaryDisplay(), ...screen.getAllDisplays().filter(d => d.id !== screen.getPrimaryDisplay().id)].map(d => d.workArea));
  const win = new BrowserWindow({
    ...saved.bounds,
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
  windowSlots.set(win, slot);
  monitorRenderer(win, () => quitting);
  if (saved.maximized) win.maximize();
  if (saved.fullscreen) win.setFullScreen(true);
  const saveState = (): void => {
    if (win.isDestroyed()) return;
    try { windowStates.save(slot, { bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() }); }
    catch (error) { console.error('無法保存視窗狀態', error); }
  };
  let stateTimer: NodeJS.Timeout | undefined;
  const scheduleState = (): void => { clearTimeout(stateTimer); stateTimer = setTimeout(saveState, 250); };
  win.on('resize', scheduleState);
  win.on('move', scheduleState);
  win.on('maximize', scheduleState);
  win.on('unmaximize', scheduleState);
  win.on('enter-full-screen', scheduleState);
  win.on('leave-full-screen', scheduleState);
  win.on('close', () => { clearTimeout(stateTimer); saveState(); });
  const origin = new URL(url).origin;
  coreOrigin = origin;
  mainWindow = win;
  win.on('focus', () => { mainWindow = win; });
  win.on('closed', () => {
    windowSlots.delete(win);
    if (mainWindow === win) mainWindow = [...windowSlots.keys()].at(-1) ?? null;
  });
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
  if (artifactSmoke) {
    void win.loadURL(url).then(() => reportArtifactSmoke(win, artifactSmoke, origin)).catch(() => app.exit(1));
  } else void win.loadURL(url);
  return win;
}

app.on('before-quit', (event) => {
  disposeTray?.(); disposeTray = undefined;
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
    if (artifactSmoke) await fs.writeFile(path.join(artifactSmoke, 'process.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    ipcMain.handle('pick-folder', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !windowSlots.has(win) || !acceptsFrame(event.senderFrame?.url, coreOrigin)) return null;
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.on('set-badge', (event, count: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !windowSlots.has(win) || !acceptsFrame(event.senderFrame?.url, coreOrigin) || !validBadgeCount(count)) return;
      if (process.platform !== 'win32') app.setBadgeCount(count);
    });
    ipcMain.on('focus-window', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !windowSlots.has(win) || !acceptsFrame(event.senderFrame?.url, coreOrigin)) return;
      mainWindow = win;
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
    installMenu(() => { if (!quitting) createWindow(url); });
    disposeTray = createTray(app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(APP_ROOT, 'build', 'icon.png'), coreOrigin, focusWindow, () => { if (!quitting) createWindow(url); });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
    });
  })
  .catch((err: unknown) => {
    if (quitting) return;
    dialog.showErrorBox('YuMeewADE 無法啟動', err instanceof Error ? err.message : String(err));
    app.quit();
  });
