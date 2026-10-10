// CLI 對話契約；核心只認這個介面，工具摘要不混入回答文字。

import type { Ask, QuotaWindow, TurnUsage } from '../shared/types.ts';

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
  /** 不送指示、從 CLI 本機紀錄讀最近一次額度；沒有可讀紀錄回 null。 */
  quota?(): Promise<Extract<CliEvent, { type: 'quota' }> | null>;
}
