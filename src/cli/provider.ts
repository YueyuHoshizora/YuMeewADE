// CLI 對話契約；核心只認這個介面，工具摘要不混入回答文字。

import type { Ask, QuotaWindow, SlashCommand, TurnUsage } from '../shared/types.ts';

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
  /** 已保存的圖片絕對路徑。 */
  images?: string[];
  /** 本輪固定的帳戶；省略＝default。執行中切換不改變這一輪。 */
  accountId?: string;
  /** 額外帳戶的 CLI 設定目錄；省略＝繼承 CLI 預設。 */
  configDir?: string;
  /** 原生 slash 的完整文字；prompt 此時作為系統前言，不混入指令。 */
  slashCommand?: string;
}

export type CliEvent =
  | { type: 'session'; id: string }
  | { type: 'delta'; text: string }
  /** 最終完整回覆（有些 CLI 不逐字串流，只給整段）。 */
  | { type: 'result'; text: string }
  | { type: 'usage'; usage: TurnUsage }
  | { type: 'tool'; text: string }
  | { type: 'asks'; asks: Ask[] }
  /** 帳號額度（CLI 回報；at＝資料時間 ISO）。 */
  | { type: 'quota'; windows: QuotaWindow[]; limited: boolean; at: string }
  /** CLI 實測輸出用量／耗時；同一 run 的最新訊息或回合取代舊樣本，絕非文字估算或校正增量。 */
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
  available(): Promise<boolean>;
  send(opts: SendOptions, onEvent: (ev: CliEvent) => void): CliRun;
  commands?(cwd: string, configDir?: string): Promise<SlashCommand[]>;
  /** 原生回傳原文；自訂模板回傳展開後的提示。未知指令必須拒絕。 */
  resolveCommand?(text: string, cwd: string, configDir?: string): Promise<{ text: string; native: boolean }>;
  /** 不送指示，查指定設定目錄的帳號額度；沒有資料回 null。 */
  quota?(configDir?: string): Promise<Extract<CliEvent, { type: 'quota' }> | null>;
}
