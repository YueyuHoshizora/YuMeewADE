import { app } from 'electron';

/** Native dialogs run before or without a renderer, so they follow the OS locale like the menus do. */
export function localeTable<T>(table: Readonly<Record<string, T>>): T {
  const locale = app.getLocale();
  return table[locale] ?? table[locale.split('-')[0]!] ?? table['en']!;
}

export interface DesktopText {
  /** `{code}` is replaced with the exit code. */
  coreExited: string;
  coreFailed: string;
  coreTimeout: string;
  startFailed: string;
  rendererGone: string;
  rendererUnresponsive: string;
  reload: string;
  wait: string;
  quit: string;
  unsaved: string;
  unsavedDetail: string;
  leave: string;
  stay: string;
}

const text: Readonly<Record<string, DesktopText>> = {
  'zh-TW': { coreExited: '核心程序結束（代碼 {code}）。請檢查設定檔與日誌。', coreFailed: '核心啟動失敗', coreTimeout: '核心啟動逾時', startFailed: 'YuMeewADE 無法啟動', rendererGone: '畫面程序已停止。重新載入畫面或離開應用程式？', rendererUnresponsive: '畫面暫時沒有回應。等待或重新載入？', reload: '重新載入', wait: '等待', quit: '離開', unsaved: '還有尚未儲存的編輯內容，確定要離開？', unsavedDetail: '離開後，尚未寫入檔案的變更不會被儲存。', leave: '離開', stay: '留下' },
  'zh-CN': { coreExited: '核心进程已退出（代码 {code}）。请检查配置文件与日志。', coreFailed: '核心启动失败', coreTimeout: '核心启动超时', startFailed: 'YuMeewADE 无法启动', rendererGone: '界面进程已停止。重新加载界面还是退出应用？', rendererUnresponsive: '界面暂时没有响应。等待还是重新加载？', reload: '重新加载', wait: '等待', quit: '退出', unsaved: '还有尚未保存的编辑内容，确定要离开？', unsavedDetail: '离开后，尚未写入文件的更改不会被保存。', leave: '离开', stay: '留下' },
  en: { coreExited: 'The core process exited (code {code}). Check the configuration file and logs.', coreFailed: 'The core failed to start', coreTimeout: 'The core did not start in time', startFailed: 'YuMeewADE cannot start', rendererGone: 'The window process stopped. Reload the window or quit the app?', rendererUnresponsive: 'The window is not responding. Wait or reload?', reload: 'Reload', wait: 'Wait', quit: 'Quit', unsaved: 'You have unsaved edits. Leave anyway?', unsavedDetail: 'Changes not yet written to files will not be saved.', leave: 'Leave', stay: 'Stay' },
  ja: { coreExited: 'コアプロセスが終了しました（コード {code}）。設定ファイルとログを確認してください。', coreFailed: 'コアの起動に失敗しました', coreTimeout: 'コアの起動がタイムアウトしました', startFailed: 'YuMeewADE を起動できません', rendererGone: '画面プロセスが停止しました。画面を再読み込みするか、アプリを終了しますか？', rendererUnresponsive: '画面が応答していません。待機しますか、再読み込みしますか？', reload: '再読み込み', wait: '待機', quit: '終了', unsaved: '未保存の編集内容があります。移動してもよろしいですか？', unsavedDetail: 'ファイルにまだ書き込まれていない変更は保存されません。', leave: '移動する', stay: '留まる' },
  de: { coreExited: 'Der Kernprozess wurde beendet (Code {code}). Bitte Konfigurationsdatei und Protokolle prüfen.', coreFailed: 'Der Kern konnte nicht gestartet werden', coreTimeout: 'Der Kern ist nicht rechtzeitig gestartet', startFailed: 'YuMeewADE kann nicht starten', rendererGone: 'Der Fensterprozess wurde beendet. Fenster neu laden oder App beenden?', rendererUnresponsive: 'Das Fenster reagiert nicht. Warten oder neu laden?', reload: 'Neu laden', wait: 'Warten', quit: 'Beenden', unsaved: 'Es gibt ungespeicherte Änderungen. Trotzdem verlassen?', unsavedDetail: 'Noch nicht in Dateien geschriebene Änderungen werden nicht gespeichert.', leave: 'Verlassen', stay: 'Bleiben' },
  fr: { coreExited: 'Le processus principal s’est arrêté (code {code}). Vérifie le fichier de configuration et les journaux.', coreFailed: 'Le cœur n’a pas pu démarrer', coreTimeout: 'Le cœur n’a pas démarré à temps', startFailed: 'YuMeewADE ne peut pas démarrer', rendererGone: 'Le processus de la fenêtre s’est arrêté. Recharger la fenêtre ou quitter l’app ?', rendererUnresponsive: 'La fenêtre ne répond pas. Attendre ou recharger ?', reload: 'Recharger', wait: 'Attendre', quit: 'Quitter', unsaved: 'Des modifications ne sont pas enregistrées. Quitter quand même ?', unsavedDetail: 'Les modifications qui ne sont pas encore écrites dans les fichiers ne seront pas enregistrées.', leave: 'Quitter', stay: 'Rester' },
  it: { coreExited: 'Il processo principale è terminato (codice {code}). Controlla il file di configurazione e i log.', coreFailed: 'Avvio del core non riuscito', coreTimeout: 'Il core non si è avviato in tempo', startFailed: 'Impossibile avviare YuMeewADE', rendererGone: 'Il processo della finestra si è interrotto. Ricaricare la finestra o uscire dall’app?', rendererUnresponsive: 'La finestra non risponde. Attendere o ricaricare?', reload: 'Ricarica', wait: 'Attendi', quit: 'Esci', unsaved: 'Ci sono modifiche non salvate. Uscire comunque?', unsavedDetail: 'Le modifiche non ancora scritte nei file non verranno salvate.', leave: 'Esci', stay: 'Resta' },
};

export function desktopText(): DesktopText { return localeTable(text); }
