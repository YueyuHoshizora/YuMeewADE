// UI 與核心共用的型別；只放純資料型別，不得 import Node 模組。

export const PROJECT_STATUSES = ['未開始', '進行中', '暫停', '完成'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATES = ['未開始', '進行中', '等待回覆', '暫停', '完成'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const CLI_NAMES = ['claude', 'codex', 'mock'] as const;
export type CliName = (typeof CLI_NAMES)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ProjectIssue {
  text: string;
  level: string;
}

export interface Project {
  name: string;
  status: ProjectStatus;
  updated: string;
  related: string[];
  issues: ProjectIssue[];
}

export interface Task {
  id: string;
  title: string;
  state: TaskState;
  phase: string;
  owner: string;
  role: string;
  cli: string;
  model: string;
  effort: string;
  question: string;
  updated: string;
  /** 「## 步驟」清單的勾選進度，由正文解析，唯讀。 */
  steps: { done: number; total: number };
}

export type TaskPatch = Partial<Pick<Task, 'title' | 'state' | 'phase' | 'owner' | 'role' | 'cli' | 'model' | 'effort' | 'question'>>;

export type ChatRole = 'user' | 'assistant' | 'error';

export interface ChatRow {
  at: string;
  role: ChatRole;
  text: string;
  cli: string;
  model?: string;
  request: string;
  /** 人工停止，已收部分照樣存檔。 */
  cancelled?: boolean;
  /** 串流中斷（CLI 異常結束），已收部分照樣存檔。 */
  interrupted?: boolean;
}

export interface ChatMeta {
  sessions: Partial<Record<string, string>>;
  /** 各 CLI 已看過的 JSONL 行數，用來組交接包。 */
  seen: Partial<Record<string, number>>;
}

export interface QueueItem {
  request: string;
  text: string;
  cli: string;
  model?: string;
  effort?: string;
  at: string;
}

export interface RoleSlot {
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
  models: Record<string, string[]>;
  roles: Record<string, RoleDef>;
}

export interface CliInfo {
  name: string;
  available: boolean;
  dangerous: boolean;
}

export interface Limits {
  promptChars: number;
  queueLength: number;
  concurrentRuns: number;
}

export interface Bootstrap {
  version: string;
  projects: Project[];
  clis: CliInfo[];
  roles: Roles;
  limits: Limits;
  workspaceRoot: string;
}

export interface RunState {
  request: string;
  cli: string;
  model?: string;
  startedAt: string;
}

export interface WorktreeStatus {
  exists: boolean;
  path: string;
  branch: string;
  dirty: string[];
  ahead: number;
}

export interface MergeResult {
  merged: boolean;
  commit?: string;
  conflicts?: string[];
}

/** SSE 事件（`GET /api/chat/stream`）。 */
export type SseEvent =
  | { event: 'ready'; data: { running: RunState | null; partial: string; queue: QueueItem[]; task: Task | null } }
  | { event: 'log'; data: ChatRow }
  | { event: 'delta'; data: { request: string; text: string } }
  | { event: 'done'; data: { request: string } }
  | { event: 'error'; data: { request: string; code: string } }
  | { event: 'queue'; data: QueueItem[] }
  | { event: 'task'; data: Task };

export interface ApiError {
  error: string;
  message: string;
}
