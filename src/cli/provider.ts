// CLI 對話契約；核心只認這個介面，工具摘要不混入回答文字。

import type { Ask, CloudCredits, ExtraUsage, QuotaWindow, ResetCredits, SlashCommand, TurnUsage } from '../shared/types.ts';

export interface SendOptions {
  /** 完整提示（含前言、交接包、使用者指示）。 */
  prompt: string;
  cwd: string;
  /** 續聊用的 session id；省略＝新會話。 */
  resumeId?: string;
  model?: string;
  effort?: string;
  /** 額外允許存取的目錄（主專案的 .ai/）。 */
  addDirs?: string[];
  /** 本輪權限；省略時使用 config 的預設。 */
  fullAccess?: boolean;
  /** Independent review policy. Providers must reject unsupported/reused sessions. */
  readonly?: boolean;
  /** 已保存的圖片絕對路徑。 */
  images?: string[];
  /** 本輪固定的帳戶；省略＝default。執行中切換不改變這一輪。 */
  accountId?: string;
  /** 額外帳戶的 CLI 設定目錄；省略＝繼承 CLI 預設。 */
  configDir?: string;
  /** 原生 slash 的完整文字；prompt 此時作為系統前言，不混入指令。 */
  slashCommand?: string;
  /** CLI 的獨立唯讀報告，不推進或清除模型對話狀態。 */
  standalone?: boolean;
  /** Fast 服務層級；省略＝依 CLI 自身設定。 */
  fast?: boolean;
}

/** `/fast` 的參數：無參數＝切換。 */
export type FastChange = 'toggle' | 'on' | 'off' | 'status';

export type CliEvent =
  | { type: 'session'; id: string }
  | { type: 'delta'; text: string }
  /** 最終完整回覆（有些 CLI 不逐字串流，只給整段）。 */
  | { type: 'result'; text: string }
  | { type: 'usage'; usage: TurnUsage }
  | { type: 'tool'; text: string }
  | { type: 'permission'; id: string; tool: string; input: Record<string, unknown>; respond: (allow: boolean) => void }
  | { type: 'asks'; asks: Ask[] }
  /** 帳號額度（CLI 或 API 回報；at＝資料時間 ISO；prepaidCents＝明確回報的預付美元分餘額；resetCredits＝明確回報的重置券）。 */
  | { type: 'quota'; windows: QuotaWindow[]; limited: boolean; at: string; prepaidCents?: number; resetCredits?: ResetCredits; extraUsage?: ExtraUsage; cloudCredits?: CloudCredits }
  /** CLI 實測輸出用量／耗時；runId 識別一則訊息或完整回合，同一量測累計值取代舊樣本，不同訊息獨立保留。 */
  | { type: 'tokens'; runId: string; count: number; spanMs: number; at: number }
  /** 內部原因，只進日誌，不對外。 */
  | { type: 'error'; reason: string };

export interface RunOutcome {
  ok: boolean;
  /** 被 stop() 終止。 */
  stopped: boolean;
  reason?: string;
}

export interface CliRun {
  stop(): void;
  /** 子行程結束（不論成敗）時 resolve；永不 reject。 */
  done: Promise<RunOutcome>;
}

export interface CliProvider {
  readonly name: string;
  /** 目前設定下是否會附上危險旗標。 */
  readonly dangerous: boolean;
  /** False/absent means review is refused, not silently downgraded. */
  readonly supportsReadonly?: boolean;
  readonly supportsApprovals?: boolean;
  readonly readonlyEnforcement?: 'native-sandbox' | 'tool-allowlist';
  available(): Promise<boolean>;
  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun;
  commands?(cwd: string, configDir?: string): Promise<SlashCommand[]>;
  /** 原生回傳原文；自訂模板回傳展開後的提示；`fast` 是 App 保存的作業設定而非模型回合。未知指令必須拒絕。 */
  resolveCommand?(text: string, cwd: string, configDir?: string): Promise<{ text: string; native: boolean; standalone?: boolean; fast?: FastChange }>;
  /** 不送指示，查指定設定目錄的帳號額度；沒有資料回 null。 */
  quota?(configDir?: string): Promise<Extract<CliEvent, { type: 'quota' }> | null>;
}

/** A quota time a CLI reports in Unix seconds → ISO, or null when it is no usable date (`toISOString` would throw). */
export function quotaTime(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
