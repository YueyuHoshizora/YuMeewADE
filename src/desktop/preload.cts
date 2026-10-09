// sandbox preload 僅暴露固定 IPC，不將 ipcRenderer 或任意 channel 交給 renderer。
import type { ContextBridge, IpcRenderer } from 'electron';
interface ElectronPreloadApi { contextBridge: ContextBridge; ipcRenderer: IpcRenderer; }
const electron: ElectronPreloadApi = require('electron');
electron.contextBridge.exposeInMainWorld('yumeewade', Object.freeze({
  desktop: true,
  platform: process.platform,
  pickFolder: (): Promise<string | null> => electron.ipcRenderer.invoke('pick-folder') as Promise<string | null>,
}));
