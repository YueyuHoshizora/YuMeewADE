// 對外錯誤：狀態碼＋錯誤碼＋可翻譯的 detail 代碼（UI 依 detail 顯示各語言）；內部原因放在 cause，只進本地日誌。

export type ErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'too_many_requests'
  | 'unavailable'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  too_many_requests: 429,
  unavailable: 503,
  internal: 500,
};

const MESSAGE: Record<ErrorCode, string> = {
  bad_request: '輸入不合法',
  forbidden: '來源不符',
  not_found: '目標不存在',
  conflict: '狀態衝突',
  too_large: '內容過大',
  too_many_requests: '請求太頻繁',
  unavailable: '資源已達上限',
  internal: '內部錯誤',
};

/** detail 代碼與繁中補充（UI 以 `detail.<代碼>` 翻譯；{field} 為欄位名）。 */
export const DETAIL_MESSAGES = {
  invalid_project_name: '專案名稱不合法',
  invalid_task_id: '作業 ID 不合法',
  project_exists: '同名專案已存在',
  phase_changed: '專案階段已經變更，請重新整理後再確認',
  phase_duplicate: '階段名稱不能重複',
  project_missing: '專案不存在',
  task_missing: '作業不存在',
  worktree_missing: '尚未建立工作副本',
  queue_item_missing: '隊列中沒有這筆指示',
  invalid_state: '狀態值不合法',
  no_updatable_fields: '沒有可更新的欄位',
  patch_not_object: 'patch 必須是物件',
  body_not_object: '請求體必須是 JSON 物件',
  bad_json: 'JSON 格式錯誤',
  title_required: '標題不得為空',
  role_missing: 'role 不存在',
  invalid_effort: 'effort 不合法',
  no_cli_for_task: '此作業未指定可執行的 CLI（role 為人或未設定）',
  chat_stopped: '準備期間已停止指示，未啟動 AI',
  cli_unsupported: '不支援的 CLI：{field}',
  slash_unsupported: '目前的 CLI 模式不支援此指令，或找不到該指令',
  cli_unavailable: '{field} 未安裝或不可用',
  credentials_unavailable: '無法匯入或使用帳號憑證；請確認 CLI 已登入且系統安全儲存可用',
  login_failed: 'OAuth 登入未完成或逾時；請在瀏覽器完成授權後重試',
  field_required: '{field} 必填',
  field_too_long: '{field} 過長',
  field_type: '{field} 必須是字串',
  queue_full: '排隊指示已達上限',
  runs_limit: '同時執行中的對話已達上限',
  sse_limit: 'SSE 連線數已達上限',
  git_failed: 'git 指令失敗',
  worktree_not_git: '副本目錄已存在但不是 worktree',
  worktree_wrong_branch: '副本不在作業分支上',
  worktree_dirty: '副本有未提交的變更，請先收編或手動清理',
  merge_while_running: '作業執行中，請先停止再收編',
  remove_while_running: '作業執行中，不能移除副本',
  archive_while_running: '作業執行中，不能封存',
  archive_has_worktree: '請先移除工作副本再封存',
  archive_project_running: '有作業執行中，不能封存',
  archive_project_has_worktrees: '請先移除所有工作副本再封存',
  root_not_absolute: '工作區路徑必須是絕對路徑（可用 ~ 開頭）',
  root_not_directory: '工作區路徑已存在但不是資料夾',
  root_unwritable: '無法在這個位置建立工作區',
  relocate_busy: 'AI 執行中或正在切換，暫時不能切換工作區',
  // Git worktree workflow
  merge_conflict: '合併時發生衝突，請先在副本解決後再合併',
  merge_excluded: '此副本已排除合併',
  merge_in_progress: '已有尚未完成的合併，請先處理',
  worktree_exists: '副本仍存在，不能清除紀錄',
  unmerge_unavailable: '主資料夾之後已有變更或未提交的內容，無法自動撤銷這次合併',
  fork_while_running: '作業執行中，請先停止再分支',
  file_missing: '找不到這個檔案',
  // ---- BackendChat ----
  mode_required: '執行中送出請選擇取消重做、補充說明或做完接續',
  rollback_while_running: '作業執行中，請先停止再還原',
  checkpoint_missing: '找不到這則指示的檢查點，無法還原',
  archive_unsafe_path: '封存路徑不安全，已拒絕操作',
  archive_restore_conflict: '還原名稱或檔案衝突，不會覆寫',
  archive_cannot_preserve: '無法安全保存全部資料，原副本不會刪除',
  archive_missing: '找不到封存項目',
  verification_required: '請先對目前內容執行全部驗證並通過，再合併',
  editor_conflict: '檔案已被外部修改；保留編輯內容，請重新開啟檔案比對',
  editor_readonly: '二進位或截斷檔案不可編輯',
  editor_language_unavailable: '本機語言服務未設定、失敗或逾時',
  editor_running: '作業執行中，請先停止再儲存',
  git_workbench_running: '請先停止此專案所有執行中的作業',
  git_workbench_path: '此檔案不允許操作或不在目前變更清單',
  git_workbench_secret: '已暫存機密檔案，拒絕提交',
  git_conflict_markers: '請先移除所有衝突標記',
  git_commit_message: '請輸入有效的提交訊息',
  git_nothing_staged: '沒有已暫存的變更',
  git_branch_invalid: '分支名稱不合法',
  git_remote_invalid: '遠端名稱不合法',
  git_confirm_required: '必須明確確認發布操作',
  git_pr_invalid: 'Pull Request 欄位不合法',
  gh_unavailable: '找不到可用的 gh CLI',
  gh_auth_required: '請先用 gh auth login 登入',
  gh_remote_required: '找不到有效的 GitHub 遠端儲存庫',
  gh_pr_failed: '建立 Pull Request 失敗；請確認已推送來源分支與權限',
  workflow_invalid: '流程內容不合法或已完成，請先儲存有效流程',
  workflow_busy: '角色流程正在執行，請先停止',
  task_busy: '此作業有終端機、執行、預覽、除錯、驗證、審查或 AI 正在進行，請先停止或關閉後再試',
  workflow_cycle: '作業相依不能形成循環',
  workflow_dependencies: '前置作業尚未由人核可完成',
  workflow_interrupted: '核心重啟已暫停流程，請檢查後明確繼續',
  workflow_human: '等待人工完成及核可本階段',
  workflow_step_failed: '階段失敗或需要人判斷，流程已停止',
  workflow_stopped: '人已停止流程',
  care_busy: '請先停止執行中的作業及其他操作再備份或還原',
  care_changed: '備份期間檔案已變動，請停止外部編輯後重試',
  care_backup_invalid: '備份內容無效或不安全',
  care_destination_exists: '目的地已存在，不會覆寫',
  care_external_required: '備份缺少外部程式碼，無法完整還原',
  care_repository_unsupported: '此儲存庫結構不支援安全完整備份',
  care_closed: '工作區維護服務已關閉',
  project_trust_invalid: '專案信任設定不合法，請重新檢查',
  project_trust_changed: '專案路徑或信任設定已改變，請重新確認',
  project_restricted: '此專案已限制執行；請檢查來源並明確信任後再執行',
  usage_ack_required: '下一輪 AI 執行前必須確認用量警告',
} as const;

export type DetailCode = keyof typeof DETAIL_MESSAGES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: DetailCode | undefined;
  readonly field: string | undefined;
  /** 可對外的補充（繁中；不含路徑、堆疊）。 */
  readonly publicMessage: string;

  constructor(code: ErrorCode, detail?: DetailCode, options: { cause?: unknown; field?: string } = {}) {
    const publicMessage = detail ? DETAIL_MESSAGES[detail].replace('{field}', options.field ?? '') : MESSAGE[code];
    super(publicMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
    this.field = options.field;
    this.publicMessage = publicMessage;
  }

  toJSON(): { error: ErrorCode; message: string; detail?: DetailCode; field?: string } {
    return { error: this.code, message: this.publicMessage, ...(this.detail ? { detail: this.detail } : {}), ...(this.field ? { field: this.field } : {}) };
  }
}
