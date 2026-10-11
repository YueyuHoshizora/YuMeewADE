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
  cli_unsupported: '不支援的 CLI：{field}',
  cli_unavailable: '{field} 未安裝或不可用',
  field_required: '{field} 必填',
  field_too_long: '{field} 過長',
  field_type: '{field} 必須是字串',
  queue_full: '排隊指示已達上限',
  runs_limit: '同時執行中的對話已達上限',
  sse_limit: 'SSE 連線數已達上限',
  git_failed: 'git 指令失敗',
  worktree_not_git: '副本目錄已存在但不是 worktree',
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
