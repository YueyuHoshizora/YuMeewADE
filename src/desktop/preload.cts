// sandbox preload 僅暴露固定 IPC，不將 ipcRenderer 或任意 channel 交給 renderer。
import type { ContextBridge, IpcRenderer } from 'electron';
interface ElectronPreloadApi { contextBridge: ContextBridge; ipcRenderer: IpcRenderer; }
const electron: ElectronPreloadApi = require('electron');
electron.contextBridge.exposeInMainWorld('yumeewade', Object.freeze({
  desktop: true,
  platform: process.platform,
  pickFolder: (): Promise<string | null> => electron.ipcRenderer.invoke('pick-folder') as Promise<string | null>,
  setBadge: (count: number): void => electron.ipcRenderer.send('set-badge', count),
  focus: (): void => electron.ipcRenderer.send('focus-window'),
  onMenuCommand: (callback: (command: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: unknown): void => {
      if (typeof command === 'string' && ['new-project', 'open-project', 'settings', 'palette', 'search'].includes(command)) callback(command);
    };
    electron.ipcRenderer.on('menu-command', listener);
    return () => { electron.ipcRenderer.removeListener('menu-command', listener); };
  },
}));
