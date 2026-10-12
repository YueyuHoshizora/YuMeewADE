import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { localeTable } from './messages.ts';

export type MenuCommand = 'new-project' | 'open-project' | 'settings' | 'palette' | 'search' | 'find';
const labels: Record<string, readonly string[]> = {
  'zh-TW': ['檔案', '新增專案', '開啟專案', '新增視窗', '設定', '編輯', '檢視', '指令面板', '搜尋', '視窗', '說明', '使用說明', '顯示', '執行中', '離開', '尋找'],
  'zh-CN': ['文件', '新建项目', '打开项目', '新建窗口', '设置', '编辑', '视图', '命令面板', '搜索', '窗口', '帮助', '使用说明', '显示', '运行中', '退出', '查找'],
  en: ['File', 'New project', 'Open project', 'New window', 'Settings', 'Edit', 'View', 'Command palette', 'Search', 'Window', 'Help', 'README', 'Show', 'Running', 'Quit', 'Find'],
  ja: ['ファイル', '新規プロジェクト', 'プロジェクトを開く', '新規ウィンドウ', '設定', '編集', '表示', 'コマンドパレット', '検索', 'ウィンドウ', 'ヘルプ', '使い方', '表示', '実行中', '終了', 'ページ内を検索'],
  de: ['Datei', 'Neues Projekt', 'Projekt öffnen', 'Neues Fenster', 'Einstellungen', 'Bearbeiten', 'Ansicht', 'Befehlspalette', 'Suchen', 'Fenster', 'Hilfe', 'Anleitung', 'Anzeigen', 'Aktiv', 'Beenden', 'Finden'],
  fr: ['Fichier', 'Nouveau projet', 'Ouvrir un projet', 'Nouvelle fenêtre', 'Réglages', 'Édition', 'Affichage', 'Palette de commandes', 'Rechercher', 'Fenêtre', 'Aide', 'Guide', 'Afficher', 'En cours', 'Quitter', 'Rechercher dans la page'],
  it: ['File', 'Nuovo progetto', 'Apri progetto', 'Nuova finestra', 'Impostazioni', 'Modifica', 'Vista', 'Tavolozza comandi', 'Cerca', 'Finestra', 'Aiuto', 'Guida', 'Mostra', 'In esecuzione', 'Esci', 'Trova'],
};
export function desktopLabels(): readonly string[] { return localeTable(labels); }
export function installMenu(newWindow: () => void): void {
  const l = desktopLabels();
  const command = (label: string, name: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({ label, ...(accelerator ? { accelerator } : {}), click: () => BrowserWindow.getFocusedWindow()?.webContents.send('menu-command', name) });
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, command(l[4]!, 'settings', 'CmdOrCtrl+,'), { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] } as MenuItemConstructorOptions] : []),
    { label: l[0]!, submenu: [command(l[1]!, 'new-project', 'CmdOrCtrl+N'), command(l[2]!, 'open-project', 'CmdOrCtrl+O'), { label: l[3]!, accelerator: 'CmdOrCtrl+Shift+N', click: newWindow }, { role: 'close' }, ...(process.platform === 'darwin' ? [] : [command(l[4]!, 'settings'), { role: 'quit' } as MenuItemConstructorOptions])] },
    // The accelerator is only displayed: registering it would steal Mod+F from CodeMirror search and the terminal; the renderer handles the key.
    { label: l[5]!, submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { ...command(l[15]!, 'find', 'CmdOrCtrl+F'), registerAccelerator: false }] },
    { label: l[6]!, submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : []), { type: 'separator' }, command(l[7]!, 'palette', 'CmdOrCtrl+Shift+P'), command(l[8]!, 'search', 'CmdOrCtrl+Shift+F')] },
    { label: l[9]!, role: 'windowMenu' },
    { label: l[10]!, submenu: [{ label: l[11]!, click: () => { void shell.openExternal('https://github.com/YueyuHoshizora/YuMeewADE#readme'); } }, { label: 'GitHub', click: () => { void shell.openExternal('https://github.com/YueyuHoshizora/YuMeewADE'); } }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
