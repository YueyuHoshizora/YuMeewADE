// UI 與核心共用的型別（API 契約）；只放純資料型別，不得 import Node 模組。
// 流程對齊參考專案 project-hub：專案（含階段）→ 作業（含子作業／分支）→ 同一作業內的對話；狀態值寫入檔案。
import type { ReviewSnapshot } from './review-types.ts';
export type * from './project-trust.ts';
export type * from './editor-workbench.ts';
export type * from './review-types.ts';
export type * from './git-precision.ts';
export type * from './execution-tools.ts';
export type * from './usage-history-types.ts';
export type * from './backup-types.ts';
export type * from './update-types.ts';

// ---- 列舉值（寫進台帳檔案的原值；UI 依值翻譯顯示） ----

export const PROJECT_STATUSES = ['未開始', '進行中', '暫停', '完成'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATES = ['未開始', '進行中', '等待回覆', '暫停', '完成'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const PHASE_STATES = ['未開始', '進行中', '完成'] as const;
export type PhaseState = (typeof PHASE_STATES)[number];

/** 能實際對話的 AI（mock 僅測試用，UI 不列出）。 */
export const AI_NAMES = ['claude', 'codex', 'grok', 'gemini', 'mock'] as const;
export type AiName = (typeof AI_NAMES)[number];

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** roles.yaml 槽位裡代表「人」的值。 */
export const HUMAN = '人';

/** 作業種類：main＝一般作業；derived＝從另一作業分出的分支。 */
export const TASK_KINDS = ['main', 'derived'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** 作業的工作位置：isolated＝git worktree 副本（預設）；direct＝直接在主資料夾。 */
export const WORKSPACE_MODES = ['isolated', 'direct'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/** 執行中送出新指示時的處理方式：① 取消並重做 ② 補充說明（一起做）③ 做完再接續。 */
export const SEND_MODES = ['redo', 'amend', 'queue'] as const;
export type SendMode = (typeof SEND_MODES)[number];

// ---- 專案 ----

export interface Phase {
  name: string;
  state: PhaseState;
}

export interface ProjectIssue {
  text: string;
  level: string;
}

/** PROJECT.md（frontmatter＋正文）。id＝Projects/ 底下的資料夾名，name 可改名不搬資料夾。 */
export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  updated: string;
  description: string;
  /** 上層專案 id（子專案）；空字串＝頂層。 */
  parent: string;
  /** 主資料夾（程式碼本體）絕對路徑；空字串＝台帳資料夾本身。 */
  body: string;
  phases: Phase[];
  related: string[];
  issues: ProjectIssue[];
  /** 正文（# 備註 之後的說明），唯讀顯示用。 */
  notes: string;
  /** 驗證指令（在作業工作副本執行，例如 `npm test`）；空字串＝未設定。 */
  verify: string;
  checks: VerificationCheck[];
  requireVerification: boolean;
  /** 驗證失敗時最多自動請 AI 修正幾次（0＝關閉）；需要先設定驗證指令。 */
  autoFix: number;
}

/** `Project.autoFix` 的上限。 */
export const AUTO_FIX_MAX = 5;

export interface NewProjectInput {
  name: string;
  description?: string;
  /** 每行一個階段；省略＝預設四階段。 */
  phases?: string[];
  parent?: string;
  body?: string;
  related?: string[];
  verify?: string;
  checks?: VerificationCheck[];
  requireVerification?: boolean;
}

export type ProjectPatch = Partial<Pick<Project, 'name' | 'status' | 'description' | 'parent' | 'body' | 'related' | 'verify' | 'autoFix' | 'checks' | 'requireVerification'>> & { phases?: Phase[] };

// ---- 作業 ----

export interface Step {
  text: string;
  done: boolean;
}

/** .ai/tasks/{id}.md。 */
export interface Task {
  id: string;
  title: string;
  state: TaskState;
  phase: string;
  role: string;
  /** 上層作業 id（子作業）；空字串＝無。 */
  parent: string;
  kind: TaskKind;
  /** kind＝derived 時的來源作業 id。 */
  derivedFrom: string;
  workspace: WorkspaceMode;
  /** 最近一次（或下次預設）使用的 AI／模型／思考強度。 */
  cli: string;
  model: string;
  effort: string;
  /** AI 提出、等人回答的問題；空字串＝沒有。 */
  question: string;
  /** 工作副本路徑（建立後寫入；合併或清除後清空）。 */
  workdir: string;
  mergeExcluded: boolean;
  updated: string;
  /** 「## 步驟」清單。 */
  steps: Step[];
  /** 「## 備註」最後一行（完整內容在檔案裡）。 */
  memo: string;
  /** 「## 下一步」第一行。 */
  next: string;
  issue?: number;
  issueUrl?: string;
  due?: string;
  tags?: string[];
}

export interface NewTaskInput {
  title: string;
  role?: string;
  phase?: string;
  parent?: string;
  kind?: TaskKind;
  derivedFrom?: string;
  workspace?: WorkspaceMode;
  steps?: string[];
  cli?: string;
  model?: string;
  effort?: string;
  issue?: number;
  issueUrl?: string;
  due?: string;
  tags?: string[];
}

export type TaskPatch = Partial<Pick<Task, 'title' | 'state' | 'phase' | 'role' | 'parent' | 'cli' | 'model' | 'effort' | 'question' | 'due' | 'tags'>>;

/** /api/state 裡的作業：台帳＋計算欄位。 */
export interface TaskView extends Task {
  /** 等人確認完成（AI 自行寫了「完成」但人還沒核可，或步驟全勾）。 */
  confirm: boolean;
  /** 已有對話紀錄（.ai/chat/{id}.jsonl 存在且非空）；狀態圓點區分「處理過」與「未碰過」。 */
  hasChat: boolean;
  /** 工作副本目前存在。 */
  copy: boolean;
  /** task.workdir 有值但資料夾已不存在。 */
  copyMissing: boolean;
}

export interface ProjectView extends Project {
  tasks: TaskView[];
  /** 目前階段（第一個未完成的階段名稱；全部完成＝空字串）。 */
  currentPhase: string;
  /** 目前階段的作業都完成了，提示「前往下一階段」。 */
  phaseOffer: boolean;
  /** 主資料夾是 git repo（決定作業能否用副本）。 */
  isGit: boolean;
  /** 解析後的主資料夾絕對路徑（body 為空時＝台帳資料夾）。 */
  bodyPath: string;
  /** 台帳資料夾絕對路徑。 */
  dir: string;
  /** 快速開始上次的選擇。 */
  startPick: AiPick | null;
  pinned: boolean;
}

// ---- AI／模型 ----

export interface AiPick {
  ai: string;
  model: string;
  effort: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** 這個模型接受的思考強度（CLI 原值，例如 low／medium／high／xhigh／max）。 */
  efforts: string[];
  defaultEffort: string;
}

export interface AiInfo {
  name: AiName;
  available: boolean;
  /** `--version` 的版本號；取不到為空字串。 */
  version: string;
  models: ModelInfo[];
  /** 模型清單來源：cli-cache／cli／builtin／unavailable（查詢失敗且沒有清單）。 */
  source: string;
  refreshedAt: string;
  /** 目前是否以「跳過權限確認」啟動。 */
  fullAccess: boolean;
}

/** 帳號額度的一個時間窗（例：5 小時、7 天）。 */
export interface QuotaWindow {
  /** 顯示用短標籤：`5h`、`7d`；CLI 給未知的窗口時為原始 key。 */
  label: string;
  /** 已用百分比 0–100。 */
  usedPercent: number;
  /** 重置時間（ISO）；CLI 沒提供為 null。 */
  resetsAt: string | null;
}

/** 帳號持有的「額度重置券」；只收後端明確回報的欄位，不含不透明 ID。 */
export interface ResetCredit {
  title: string | null;
  /** 到期時間（ISO）；後端回報不會到期為 null。 */
  expiresAt: string | null;
}

export interface ResetCredits {
  /** 後端回報的可用張數；明細可能被後端截斷，張數不一定等於 credits 長度。 */
  availableCount: number;
  credits: ResetCredit[];
}

/**
 * 額外使用額度（超出訂閱額度後的付費用量）的「餘額」；三家統一為餘額，單位為 currency 的最小單位（USD 為 cents）。
 * 後端沒回報、方案沒有這項或沒開啟時為 0。
 */
/** ExtraUsage.currency 的特例：以「點數」計（Codex），balance 是點數本身而非貨幣最小單位。 */
export const CREDITS_UNIT = 'credits';

export interface ExtraUsage {
  /** 無上限（Codex credits.unlimited）。 */
  unlimited: boolean;
  /** ISO 4217 幣別；Codex 的點數用 CREDITS_UNIT。 */
  currency: string;
  balance: number;
}

/** Claude 雲端工作階段的限期點數餘額；美元 cents；未獲配或已過期時 expiresAt 為 null。 */
export interface CloudCredits {
  balance: number;
  expiresAt: string | null;
}

/** 各 AI 帳號的額度；只在記憶體，核心重啟後等下一次回報。 */
export interface AiUsage {
  ai: string;
  /** default 代表 CLI 目前的預設設定目錄。 */
  account: string;
  /** 查詢失敗仍保留上次數值，但不能當成目前可用額度。 */
  status: 'ready' | 'unavailable';
  windows: QuotaWindow[];
  /** CLI 回報目前已達上限。 */
  limited: boolean;
  /** 額度資料取得時間（ISO）；尚無資料為 null。 */
  quotaAt: string | null;
  /** API 明確回報的預付餘額（USD cents）；不由百分比推估。 */
  prepaidCents?: number;
  /** 後端明確回報的重置券（Claude、Codex）；沒有回報為 undefined。 */
  resetCredits?: ResetCredits;
  /** 後端明確回報的額外使用額度；沒有回報為 undefined。 */
  extraUsage?: ExtraUsage;
  /** Claude 的雲端工作階段點數；沒有回報為 undefined。 */
  cloudCredits?: CloudCredits;
}

export interface UsageState {
  ais: AiUsage[];
  /** 最近量測的輸出速率（各訊息／回合／步驟快照的加權平均）；尚無有效量測時為 null。 */
  tokensPerSecond: number | null;
  /** Codex 下一次全域重置的排程時間（ISO）；沒有排程或查不到時省略。 */
  codexReset?: string;
}

/** 額外帳戶以已登入的獨立 CLI 設定目錄隔離，不複製或保存憑證。 */
export interface CliAccount {
  id: string;
  name: string;
  configDir: string;
}

export interface Settings {
  /** 新作業／快速開始的預設選擇。 */
  initial: AiPick;
  /** 選單隱藏的模型 id（依 AI 分組）。 */
  hiddenModels: Partial<Record<string, string[]>>;
  /** 選單中的模型順序（依 AI 分組；沒列到的排在後面）。 */
  modelOrder: Partial<Record<string, string[]>>;
  /** 各 AI 是否跳過權限確認（預設依 config.yaml 的 cli.*.dangerous）。 */
  fullAccess: Partial<Record<string, boolean>>;
  accounts: Partial<Record<string, CliAccount[]>>;
  /** 每種 AI 各一個作用中帳戶，未設定時為 default。 */
  activeAccounts: Partial<Record<string, string>>;
}

export type SettingsPatch = Partial<Settings>;

// ---- 角色 ----

export interface RoleSlot {
  /** claude／codex／grok／人 */
  cli: string;
  model: string;
  effort: string;
}

export interface RoleDef {
  main: RoleSlot;
  backup?: RoleSlot;
  job: string;
}

export interface Roles {
  roles: Record<string, RoleDef>;
}

export interface RoleInput {
  name: string;
  job: string;
  main: RoleSlot;
  backup?: RoleSlot;
}

// ---- 對話 ----

export interface Ask {
  question: string;
  options: string[];
  multi: boolean;
}

/** 一輪結束後工作副本相對於輪前的變更量。 */
export interface TurnChanges {
  files: number;
  added: number;
  removed: number;
}

export interface FileMention {
  token: string; path: string; start?: number; end?: number;
  status: 'resolved' | 'not-found' | 'truncated' | 'excluded' | 'binary';
}

export type ChatRow =
  | {
      at: string;
      role: 'user';
      text: string;
      /** 送給哪個 AI。 */
      to: string;
      model?: string;
      effort?: string;
      request: string;
      /** 執行中送出的方式；answer＝回答 AI 的問題。 */
      mode?: SendMode | 'answer';
      /** 附件圖片的絕對路徑。 */
      images?: string[];
      mentions?: FileMention[];
      /** 這輪開始前工作副本的 commit（還原用）；沒有工作副本時不帶。 */
      checkpoint?: string;
    }
  | {
      at: string;
      role: 'assistant';
      ai: string;
      model?: string;
      effort?: string;
      text: string;
      /** 失敗原因代碼（generic）；正常結束不帶。 */
      error?: string;
      /** 被人停止（含 ①取消重做／②補充 造成的中止）。 */
      stopped?: boolean;
      /** 本輪耗時毫秒。 */
      ms: number;
      /** CLI 回報的本輪 token 用量；CLI 沒回報就不帶。 */
      usage?: TurnUsage;
      /** 本輪結束時工作副本的 commit；與同一輪使用者訊息的 checkpoint 之間就是本輪的變更。 */
      after?: string;
      changes?: TurnChanges;
      request: string;
      asks?: Ask[];
    }
  | {
      at: string;
      role: 'event';
      ai?: string;
      /** 工具呼叫摘要（指令、讀寫檔）；UI 預設收合。 */
      tool?: boolean;
      text: string;
      /** 工作副本曾被還原；交接包會帶這一則，避免 AI 沿用過時記憶。 */
      rollback?: boolean;
      request?: string;
    };

export interface QueueItem {
  id: string;
  text: string;
  ai: string;
  model?: string;
  effort?: string;
  images?: string[];
  at: string;
  /** 自動開始失敗時的錯誤代碼。 */
  error?: string;
}

export interface ToolApproval {
  id: string;
  tool: string;
  summary: string;
  expiresAt: string;
}

export interface Busy {
  request: string;
  ai: string;
  model?: string;
  effort?: string;
  startedAt: string;
  /** 本輪是從哪種方式開始的。 */
  mode?: SendMode | 'answer';
  approvals?: ToolApproval[];
  approvalUnsupported?: boolean;
}

export interface RunningInfo extends Busy {
  project: string;
  task: string;
}

export interface SendInput {
  project: string;
  task: string;
  text: string;
  ai?: string;
  model?: string;
  effort?: string;
  /** 執行中必填。 */
  mode?: SendMode;
  /** true＝這則是在回答作業的 question（成功後清掉 question）。 */
  answer?: boolean;
  /** 先以 /api/upload 上傳得到的 id。 */
  images?: string[];
  /** 從隊列取出這筆直接開始（停止後或重啟後的「▶ 開始」）。 */
  fromQueue?: string;
}

export interface SendResult {
  request: string;
  queued: boolean;
}

export interface StartInput {
  project: string;
  text: string;
  ai: string;
  model?: string;
  effort?: string;
  images?: string[];
}

export interface StartResult {
  task: Task;
  request: string;
}

export interface UploadResult {
  id: string;
  name: string;
  /** GET 預覽網址。 */
  url: string;
}

/** 對話分頁：snapshot 只帶最後 HISTORY_PAGE 列，往上捲時以 /api/chat/history 補較早的列。 */
export const HISTORY_PAGE = 200;

/** `GET /api/chat/history?project&task&before=<index>`：對話檔第 [max(0, before − HISTORY_PAGE), before) 列。 */
export interface ChatHistory {
  rows: ChatRow[];
  /** rows[0] 在整份對話中的索引（0 起算；對話檔只追加，索引不變）。 */
  start: number;
}

/** `GET /api/search?q=`：跨專案搜尋作業標題與對話內容。 */
export interface SearchHit {
  project: string;
  task: string;
  /** 作業標題。 */
  title: string;
  kind: 'task' | 'chat';
  /** kind＝chat：命中列在整份對話中的索引（同 ChatHistory.start 的座標）。 */
  index?: number;
  role?: ChatRow['role'];
  at?: string;
  /** 命中處前後的純文字片段。 */
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 命中數超過上限而截斷。 */
  truncated: boolean;
}

/** 作業對話流（`GET /api/chat/stream?project&task`）。snapshot 的 start 為 rows[0] 的索引。 */
export type ChatEvent =
  | { event: 'snapshot'; data: { rows: ChatRow[]; start: number; busy: Busy | null; partial: string; queue: QueueItem[] } }
  | { event: 'busy'; data: Busy }
  | { event: 'approvals'; data: ToolApproval[] }
  /** 增量文字（客戶端自行累加到 partial）。 */
  | { event: 'delta'; data: { request: string; text: string } }
  | { event: 'row'; data: ChatRow }
  | { event: 'queue'; data: QueueItem[] }
  | { event: 'idle'; data: { request: string } };

/** 全域事件流（`GET /api/events`）：changed＝影響 /api/state 的變更，客戶端重抓；usage＝額度／速度即時更新（完整清單）。 */
export type GlobalEvent =
  | { event: 'ready'; data: { version: string } }
  | { event: 'changed'; data: { project?: string; task?: string } }
  | { event: 'usage'; data: UsageState }
  | { event: 'care_backup_failed'; data: Record<string, never> }
  | { event: 'usage_record_failed'; data: Record<string, never> };

// ---- 工作副本／合併 ----

/** 一輪對話的 token 用量（CLI 自己回報的值，不估算）。 */
export interface TurnUsage {
  input: number;
  output: number;
  /** 命中快取的輸入 token（有回報才帶）。 */
  cached?: number;
  /** 供應商明確回報的本輪費用；缺少時未知，不由 token 或餘額推算。 */
  claudeUsd?: number;
  codexCredits?: number;
}

/** 作業工作副本的驗證指令執行結果（`POST /api/task/verify`）。 */
export interface VerifyResult {
  /** 正常結束且 exit code 為 0。 */
  ok: boolean;
  /** 行程 exit code；逾時或被訊號終止為 null。 */
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  /** stdout＋stderr 的尾段（有上限）。 */
  output: string;
  /** 輸出超過上限，只保留尾段。 */
  truncated: boolean;
  steps?: VerificationStepResult[];
  drifted?: boolean;
}

/** 最近一次驗證的摘要（`GET /api/task/verify`）；沒有或已失效時 API 回 null。 */
export interface VerifyStatus {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  at: string;
  steps?: VerificationStepResult[];
  drifted?: boolean;
}

/** 另一個作業的副本也改了同樣的檔案（合併時容易互相衝突）。 */
export interface TaskOverlap {
  task: string;
  title: string;
  paths: string[];
}

/** 唯讀檔案檢視（`GET /api/task/file`）。 */
export interface FileView {
  path: string;
  size: number;
  /** 只回傳前段（檔案超過上限）。 */
  truncated: boolean;
  /** 二進位檔不回內容。 */
  binary: boolean;
  text: string;
}

export interface MergePreview {
  files: number;
  added: number;
  removed: number;
  /** 副本目前的分支名；合併目標（主資料夾目前分支）。detached 時為 HEAD。 */
  branch: string;
  target: string;
  /** 合併可能衝突。 */
  conflict: boolean;
  conflictPaths: string[];
  paths: string[];
  overlaps: TaskOverlap[];
  /** 主資料夾有未提交的變更（合併前會自動儲存）。 */
  mainDirty: boolean;
}

export interface MergeResult {
  merged: boolean;
  commit?: string;
  conflicts?: string[];
  /** 已經合併過（副本沒有新東西）。 */
  already?: boolean;
  /** 合併成功但副本仍有未提交檔案，因此保留副本。 */
  leftover?: string[];
}

// ---- 操作紀錄 ----

export interface OpLogEntry {
  at: string;
  action: string;
  project?: string;
  task?: string;
  [key: string]: unknown;
}

// ---- 整體狀態（`GET /api/state`） ----

export interface Limits {
  promptChars: number;
  queueLength: number;
  concurrentRuns: number;
  uploadBytes: number;
  imagesPerSend: number;
}

/** 發行頁上適合本機系統的下載檔；installer＝安裝版，portable＝免安裝版。 */
export interface UpdateAsset { name: string; url: string; size: number; kind: 'installer' | 'portable' }
/** 比目前版本新的正式發行。 */
export interface UpdateInfo { version: string; url: string; notes: string; assets: UpdateAsset[] }

export interface AppState {
  version: string;
  /** 有比目前版本新的發行才有。 */
  update?: UpdateInfo;
  root: string;
  projects: ProjectView[];
  /** 專案排序：key＝上層專案 id（頂層為 ''），值＝子專案 id 順序。 */
  order: Record<string, string[]>;
  running: RunningInfo[];
  unread: { project: string; task: string }[];
  ais: AiInfo[];
  usage: UsageState;
  settings: Settings;
  roles: Roles;
  limits: Limits;
}

export interface ApiError {
  error: string;
  message: string;
  /** 可翻譯的補充代碼（見 shared/errors.ts DETAIL_MESSAGES）。 */
  detail?: string;
  field?: string;
}

// ---- 明確啟動的角色流程與作業相依 ----
export interface WorkflowStep { role: string; text: string; review: boolean }
export interface WorkflowResult { role: string; ai: string; request: string; at: string; ok: boolean; step?: number; invalidatedAt?: string; output?: string; approved?: boolean; evidence?: string; reviewSnapshot?: string }
export interface WorkflowPlan {
  dependencies: string[];
  steps: WorkflowStep[];
  cursor: number;
  state: 'ready' | 'running' | 'paused' | 'failed' | 'completed';
  results: WorkflowResult[];
  reason?: string;
}

export interface VerificationCheck { name: string; command: string }
export interface VerificationStepResult extends Omit<VerifyResult, 'steps' | 'drifted'> { name: string; command: string }
export interface EditorDocument extends FileView { revision: string; language: string; languageAvailable: boolean; readonly: boolean }
export interface EditorLocation { path: string; line: number; character: number }
export interface EditorDiagnostic { line: number; character: number; message: string; severity: number }
export interface EditorLanguageResult { locations: EditorLocation[]; diagnostics: EditorDiagnostic[] }
export interface ExecutionRequest { command: string; args?: string[]; kind?: 'command' | 'preview' | 'debug'; cwd?: string; env?: Record<string, string> }
export interface ExecutionOutput { sequence: number; stream: 'stdout' | 'stderr'; text: string }
export interface ExecutionRun {
  id: string; project: string; task: string; kind: 'command' | 'preview' | 'debug'; command: string; args: string[];
  status: 'running' | 'stopped' | 'failed' | 'exited'; startedAt: string; finishedAt?: string; exitCode: number | null;
  timedOut: boolean; truncated: boolean; output: ExecutionOutput[]; sequence: number; inspectorUrl?: string;
}

/** `body`：封存專案的外部主資料夾（PROJECT.md 有填時才有），供「開啟專案」比對選到的資料夾。 */
export interface ArchiveEntry { key: string; project: string; task: string; name: string; archivedAt: number; body?: string }
export interface ArchivePreview { git: string[]; preserved: string[]; unavailable: string[] }
export interface GitWorkbenchFile {
  path: string; originalPath?: string; index: string; working: string;
  staged: boolean; unstaged: boolean; untracked: boolean; conflict: boolean; secret: boolean;
}
export interface GitWorkbenchStatus {
  root: string; location: 'main' | 'task'; branch: string; upstream: string | null;
  ahead: number; behind: number; files: GitWorkbenchFile[]; branches: string[]; remotes: string[];
}
export interface GitPullRequestStatus { available: boolean; authenticated: boolean; repository: string | null }
export interface ReviewInput { ai: string; model?: string; effort?: string; text: string }
export interface ReviewResult { request: string; text: string; ai: string; session?: string; ok: boolean; asks?: Ask[]; approved: boolean; structured: boolean; snapshot?: ReviewSnapshot }
export interface ReviewCapability { supported: boolean; enforcement: 'native-sandbox' | 'tool-allowlist' | 'unsupported' }
export interface PinnedSource { path: string; start: number; end: number }
export interface TaskContext { decisions: string; sources: PinnedSource[] }
export interface ReviewDraft { path: string; oldLine?: number; newLine?: number; hash: string; code: string; comment: string }
export interface HandoffPreview { text: string; rows: number[]; start: number | null; end: number | null; truncated: boolean }
export interface ContextPreview { handoff: HandoffPreview; context: { text: string; truncated: boolean; sources: PinnedSource[] } }
export interface CareBackup { id: string; createdAt: string; complete: boolean; externalCount: number; containsSecrets: true; bytes: number }
export interface CareHealth {
  checkedAt: string; node: string; electron: string | null;
  git: { available: boolean; version: string }; writable: boolean; loopback: boolean;
  boundToLoopback: boolean; network: 'not-tested' | 'reachable' | 'unreachable';
  buildTrust: 'signed' | 'unsigned' | 'unknown';
  clis: { name: string; available: boolean; version: string; fullAccess: boolean; configuredAccounts: number; loginState: 'stored' | 'missing' | 'unknown' }[];
}
export interface CareDiagnostics {
  format: 1;
  versions: { app: string; node: string; electron: string | null; git: string };
  configuration: { loopbackOnly: boolean; workspace: string };
  capabilities: { writable: boolean; loopback: boolean; git: boolean; signedBuild: boolean };
  providers: { name: string; available: boolean; version: string; fullAccess: boolean; loginState: 'stored' | 'missing' | 'unknown' }[];
  counts: { projects: number; tasks: number; running: number }; errorCodes: string[];
}

export interface LogTail { text: string; truncated: boolean; }
export interface TaskTemplate {
  name: string;
  scope: 'project' | 'workspace';
  title: string;
  steps: string[];
  instruction: string;
}
export interface MemoryFile { name: string; text: string; revision: string }

export type McpAi = 'claude' | 'codex' | 'grok' | 'gemini';
export type McpTransport = 'stdio' | 'http' | 'sse';
export interface McpServer { name: string; transport: McpTransport; command?: string; url?: string; envKeys: string[]; headerKeys: string[]; scope: string; status: 'connected' | 'failed' | 'disabled' | 'pending' | 'enabled' | 'unknown' }
export interface McpList { supported: boolean; transports: McpTransport[]; servers: McpServer[] }
export interface McpInput { name: string; transport: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }
