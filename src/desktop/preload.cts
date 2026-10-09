// preload（sandbox 內，必須是 CommonJS，故用 require）：只暴露最小、唯讀的環境資訊（安全節 4）。

import type { ContextBridge } from 'electron';

interface ElectronPreloadApi {
  contextBridge: ContextBridge;
}

const electron: ElectronPreloadApi = require('electron');

electron.contextBridge.exposeInMainWorld('yumeewade', Object.freeze({ desktop: true, platform: process.platform }));
