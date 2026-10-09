// 對外錯誤：只帶狀態碼與固定訊息；內部原因放在 cause，只進本地日誌。

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

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** 可對外的補充（不含路徑、堆疊）；省略則用固定訊息。 */
  readonly publicMessage: string;
  constructor(code: ErrorCode, publicMessage?: string, options?: { cause?: unknown }) {
    super(publicMessage ?? MESSAGE[code], options);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.publicMessage = publicMessage ?? MESSAGE[code];
  }
}
