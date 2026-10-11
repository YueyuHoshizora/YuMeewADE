export const featureZhTW = {
  'detail.chat_stopped': '準備期間已停止指示，未啟動 AI',
  'workflow.title': '角色流程與相依', 'workflow.role': '角色', 'workflow.instruction': '本階段指示', 'workflow.readonly': '強制唯讀審查',
  'workflow.dependencies': '須先核可完成的作業', 'workflow.add': '新增階段', 'workflow.start': '啟動／繼續流程',
  'workflow.resetConfirm': '儲存會重設此流程的進度與結果，確定？', 'workflow.startConfirm': '依序執行已儲存的角色指示？這會使用 AI 額度；遇到失敗或問題會停下，不自動重試。',
  'workflow.approveHuman': '核可人工階段', 'workflow.approveConfirm': '確認這個人工階段已完成？核可後仍須明確繼續流程。',
  'workflow.help': '先儲存再啟動。角色備援只在主 CLI 尚未執行且不可用時使用；重啟不會續跑。唯讀審查僅支援具實際權限保護的 CLI。',
  'workflow.state.ready': '待啟動', 'workflow.state.running': '執行中', 'workflow.state.paused': '已暫停', 'workflow.state.failed': '已停止：失敗或需接手', 'workflow.state.completed': '流程完成（不等於作業核可）',
  'detail.workflow_invalid': '流程內容不合法或已完成，請先儲存有效流程', 'detail.workflow_busy': '角色流程正在執行，請先停止', 'detail.workflow_cycle': '作業相依不能形成循環',
  'detail.workflow_dependencies': '前置作業尚未由人核可完成', 'detail.workflow_interrupted': '核心重啟已暫停流程，請檢查後明確繼續',
  'detail.workflow_human': '等待人工完成及核可本階段', 'detail.workflow_step_failed': '階段失敗或需要人判斷，流程已停止', 'detail.workflow_stopped': '人已停止流程',
} as const;
type Messages = Record<keyof typeof featureZhTW, string>;
export const featureZhCN: Messages = {
  'detail.chat_stopped': '准备期间已停止指示，未启动 AI',
  'workflow.title': '角色流程与依赖', 'workflow.role': '角色', 'workflow.instruction': '本阶段指示', 'workflow.readonly': '强制只读审查',
  'workflow.dependencies': '须先确认完成的任务', 'workflow.add': '添加阶段', 'workflow.start': '启动／继续流程',
  'workflow.resetConfirm': '保存会重置流程进度和结果，确定？', 'workflow.startConfirm': '按顺序执行已保存的角色指示？将使用 AI 额度；失败或需要判断时停止，不自动重试。',
  'workflow.approveHuman': '确认人工阶段', 'workflow.approveConfirm': '确认人工阶段已完成？之后仍须明确继续流程。',
  'workflow.help': '先保存再启动。仅在主 CLI 未执行且不可用时使用备用角色；重启不会续跑。只读审查仅支持有实际权限保护的 CLI。',
  'workflow.state.ready': '待启动', 'workflow.state.running': '运行中', 'workflow.state.paused': '已暂停', 'workflow.state.failed': '已停止：失败或需接手', 'workflow.state.completed': '流程完成（不等于任务确认）',
  'detail.workflow_invalid': '流程无效或已完成，请先保存有效流程', 'detail.workflow_busy': '流程运行中，请先停止', 'detail.workflow_cycle': '任务依赖不能形成循环', 'detail.workflow_dependencies': '前置任务尚未由人确认完成',
  'detail.workflow_interrupted': '核心重启已暂停流程，检查后明确继续', 'detail.workflow_human': '等待人工完成并确认阶段', 'detail.workflow_step_failed': '阶段失败或需要判断，流程停止', 'detail.workflow_stopped': '人已停止流程',
};
export const featureEn: Messages = {
  'detail.chat_stopped': 'The instruction was stopped during preparation; AI was not started.',
  'workflow.title': 'Role workflow and dependencies', 'workflow.role': 'Role', 'workflow.instruction': 'Step instruction', 'workflow.readonly': 'Enforced read-only review',
  'workflow.dependencies': 'Tasks requiring human approval first', 'workflow.add': 'Add step', 'workflow.start': 'Start / resume workflow',
  'workflow.resetConfirm': 'Saving resets workflow progress and results. Continue?', 'workflow.startConfirm': 'Run the saved role instructions in order? This uses AI quota and stops on failure or questions; no automatic retry.',
  'workflow.approveHuman': 'Approve human step', 'workflow.approveConfirm': 'Confirm this human step is complete? Resuming still requires explicit action.',
  'workflow.help': 'Save before starting. A backup is selected only when the primary CLI is unavailable before execution. Restart never resumes automatically. Reviews require an enforced read-only capability.',
  'workflow.state.ready': 'Ready', 'workflow.state.running': 'Running', 'workflow.state.paused': 'Paused', 'workflow.state.failed': 'Stopped: failed or needs attention', 'workflow.state.completed': 'Workflow complete (not task approval)',
  'detail.workflow_invalid': 'Invalid or completed workflow; save a valid plan first', 'detail.workflow_busy': 'Workflow running; stop it first', 'detail.workflow_cycle': 'Task dependencies cannot contain cycles', 'detail.workflow_dependencies': 'Prerequisite tasks are not human-approved',
  'detail.workflow_interrupted': 'Restart paused this workflow; inspect it before resuming', 'detail.workflow_human': 'Waiting for human completion and approval', 'detail.workflow_step_failed': 'Step failed or needs attention; workflow stopped', 'detail.workflow_stopped': 'Workflow stopped by the user',
};
export const featureJa: Messages = {
  'detail.chat_stopped': '準備中に指示が停止されました。AI は起動していません。',
  'workflow.title': '役割フローと依存関係', 'workflow.role': '役割', 'workflow.instruction': '段階の指示', 'workflow.readonly': '強制読み取り専用レビュー',
  'workflow.dependencies': '先に人の承認が必要なタスク', 'workflow.add': '段階を追加', 'workflow.start': 'フローを開始／再開',
  'workflow.resetConfirm': '保存すると進捗と結果がリセットされます。続行しますか？', 'workflow.startConfirm': '保存した指示を順番に実行しますか？AI利用枠を使い、失敗や質問で停止します。自動再試行しません。',
  'workflow.approveHuman': '人の段階を承認', 'workflow.approveConfirm': '人の段階が完了したことを承認しますか？再開は別途操作が必要です。',
  'workflow.help': '開始前に保存してください。代替CLIは実行前に主CLIが利用できない場合のみ選択します。再起動後は自動再開しません。レビューには読み取り専用の権限制御が必要です。',
  'workflow.state.ready': '開始待ち', 'workflow.state.running': '実行中', 'workflow.state.paused': '一時停止', 'workflow.state.failed': '停止：失敗または要対応', 'workflow.state.completed': 'フロー完了（タスク承認とは別）',
  'detail.workflow_invalid': '無効または完了済みです。有効なフローを保存してください', 'detail.workflow_busy': '実行中です。先に停止してください', 'detail.workflow_cycle': 'タスク依存関係に循環は使えません', 'detail.workflow_dependencies': '前提タスクが人に承認されていません',
  'detail.workflow_interrupted': '再起動で停止しました。確認後に再開してください', 'detail.workflow_human': '人による完了と承認を待っています', 'detail.workflow_step_failed': '失敗または要判断のため停止しました', 'detail.workflow_stopped': 'ユーザーが停止しました',
};
export const featureDe: Messages = {
  'detail.chat_stopped': 'Die Anweisung wurde während der Vorbereitung gestoppt; die KI wurde nicht gestartet.',
  'workflow.title': 'Rollenablauf und Abhängigkeiten', 'workflow.role': 'Rolle', 'workflow.instruction': 'Schrittanweisung', 'workflow.readonly': 'Erzwungene schreibgeschützte Prüfung',
  'workflow.dependencies': 'Zuerst manuell zu bestätigende Aufgaben', 'workflow.add': 'Schritt hinzufügen', 'workflow.start': 'Ablauf starten / fortsetzen',
  'workflow.resetConfirm': 'Speichern setzt Fortschritt und Ergebnisse zurück. Fortfahren?', 'workflow.startConfirm': 'Gespeicherte Anweisungen nacheinander ausführen? Verbraucht KI-Kontingent und stoppt bei Fehlern oder Fragen, ohne automatische Wiederholung.',
  'workflow.approveHuman': 'Manuellen Schritt bestätigen', 'workflow.approveConfirm': 'Ist der manuelle Schritt abgeschlossen? Fortsetzen erfordert eine weitere Aktion.',
  'workflow.help': 'Vor dem Start speichern. Ersatz nur, wenn die primäre CLI vor Ausführung nicht verfügbar ist. Kein automatisches Fortsetzen nach Neustart. Prüfungen benötigen echten Schreibschutz.',
  'workflow.state.ready': 'Bereit', 'workflow.state.running': 'Läuft', 'workflow.state.paused': 'Pausiert', 'workflow.state.failed': 'Gestoppt: Fehler oder Eingriff nötig', 'workflow.state.completed': 'Ablauf fertig (keine Aufgabenfreigabe)',
  'detail.workflow_invalid': 'Ungültiger oder abgeschlossener Ablauf; zuerst gültigen Plan speichern', 'detail.workflow_busy': 'Ablauf läuft; zuerst stoppen', 'detail.workflow_cycle': 'Aufgabenabhängigkeiten dürfen keine Zyklen enthalten', 'detail.workflow_dependencies': 'Voraussetzungen sind nicht manuell bestätigt',
  'detail.workflow_interrupted': 'Neustart hat den Ablauf pausiert; vor Fortsetzen prüfen', 'detail.workflow_human': 'Wartet auf manuelle Fertigstellung und Bestätigung', 'detail.workflow_step_failed': 'Schritt fehlgeschlagen oder Eingriff nötig; Ablauf gestoppt', 'detail.workflow_stopped': 'Vom Benutzer gestoppt',
};
export const featureFr: Messages = {
  'detail.chat_stopped': 'Instruction arrêtée pendant la préparation ; l’IA n’a pas été lancée.',
  'workflow.title': 'Flux de rôles et dépendances', 'workflow.role': 'Rôle', 'workflow.instruction': 'Instruction de cette étape', 'workflow.readonly': 'Revue en lecture seule imposée',
  'workflow.dependencies': 'Tâches à valider manuellement au préalable', 'workflow.add': 'Ajouter une étape', 'workflow.start': 'Démarrer / reprendre',
  'workflow.resetConfirm': 'Enregistrer réinitialise la progression et les résultats. Continuer ?', 'workflow.startConfirm': 'Exécuter les instructions enregistrées dans l’ordre ? Cela utilise le quota IA et s’arrête en cas d’échec ou de question, sans nouvel essai automatique.',
  'workflow.approveHuman': 'Valider l’étape humaine', 'workflow.approveConfirm': 'Confirmer la fin de cette étape humaine ? La reprise nécessite une action explicite.',
  'workflow.help': 'Enregistrer avant de démarrer. Le secours est choisi uniquement si la CLI principale est indisponible avant exécution. Pas de reprise automatique après redémarrage. Les revues exigent une protection réelle en lecture seule.',
  'workflow.state.ready': 'Prêt', 'workflow.state.running': 'En cours', 'workflow.state.paused': 'En pause', 'workflow.state.failed': 'Arrêté : échec ou intervention requise', 'workflow.state.completed': 'Flux terminé (sans validation de tâche)',
  'detail.workflow_invalid': 'Flux invalide ou terminé ; enregistrer un plan valide', 'detail.workflow_busy': 'Flux en cours ; arrêter d’abord', 'detail.workflow_cycle': 'Les dépendances ne peuvent pas former de cycle', 'detail.workflow_dependencies': 'Les tâches préalables ne sont pas validées',
  'detail.workflow_interrupted': 'Le redémarrage a suspendu le flux ; vérifier avant de reprendre', 'detail.workflow_human': 'En attente de réalisation et validation humaines', 'detail.workflow_step_failed': 'Échec ou décision requise ; flux arrêté', 'detail.workflow_stopped': 'Flux arrêté par l’utilisateur',
};
export const featureIt: Messages = {
  'detail.chat_stopped': 'Istruzione arrestata durante la preparazione; l’IA non è stata avviata.',
  'workflow.title': 'Flusso ruoli e dipendenze', 'workflow.role': 'Ruolo', 'workflow.instruction': 'Istruzione del passaggio', 'workflow.readonly': 'Revisione in sola lettura imposta',
  'workflow.dependencies': 'Attività da approvare prima manualmente', 'workflow.add': 'Aggiungi passaggio', 'workflow.start': 'Avvia / riprendi flusso',
  'workflow.resetConfirm': 'Salvare azzera avanzamento e risultati. Continuare?', 'workflow.startConfirm': 'Eseguire in ordine le istruzioni salvate? Usa quota IA e si ferma in caso di errore o domande, senza tentativi automatici.',
  'workflow.approveHuman': 'Approva passaggio umano', 'workflow.approveConfirm': 'Confermi il completamento del passaggio umano? La ripresa richiede un’azione esplicita.',
  'workflow.help': 'Salva prima di avviare. La CLI di riserva viene scelta solo se quella principale non è disponibile prima dell’esecuzione. Nessuna ripresa automatica dopo riavvio. Le revisioni richiedono protezione reale in sola lettura.',
  'workflow.state.ready': 'Pronto', 'workflow.state.running': 'In esecuzione', 'workflow.state.paused': 'In pausa', 'workflow.state.failed': 'Fermo: errore o intervento richiesto', 'workflow.state.completed': 'Flusso completato (non approvazione attività)',
  'detail.workflow_invalid': 'Flusso non valido o completato; salva un piano valido', 'detail.workflow_busy': 'Flusso in esecuzione; fermalo prima', 'detail.workflow_cycle': 'Le dipendenze non possono formare cicli', 'detail.workflow_dependencies': 'Le attività preliminari non sono approvate',
  'detail.workflow_interrupted': 'Il riavvio ha sospeso il flusso; verifica prima di riprendere', 'detail.workflow_human': 'In attesa di completamento e approvazione umana', 'detail.workflow_step_failed': 'Passaggio fallito o decisione richiesta; flusso fermo', 'detail.workflow_stopped': 'Flusso fermato dall’utente',
};
