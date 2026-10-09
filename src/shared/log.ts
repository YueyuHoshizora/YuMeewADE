// 本地日誌：stderr＋檔案（超過 5 MiB 就搬成 .old 重開）。
// 規則：不寫環境變數、不寫提示全文、CLI stderr 只截前 500 字、例外堆疊只進這裡不對外。

import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
export const STDERR_SNIPPET = 500;

type Level = 'info' | 'warn' | 'error';

export class Logger {
  private file: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  /** 設定日誌檔；未設定時只寫 stderr。 */
  setFile(file: string): void {
    this.file = file;
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.write('info', msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.write('warn', msg, extra);
  }

  error(msg: string, err?: unknown, extra?: Record<string, unknown>): void {
    const detail = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack, cause: describeCause(err.cause) } : err === undefined ? undefined : { value: String(err) };
    this.write('error', msg, { ...extra, ...(detail ? { err: detail } : {}) });
  }

  private write(level: Level, msg: string, extra?: Record<string, unknown>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), level, msg, ...extra });
    if (level === 'error') process.stderr.write(line + '\n');
    else if (process.env['YUMEEWADE_QUIET'] !== '1') process.stderr.write(line + '\n');
    const file = this.file;
    if (!file) return;
    this.chain = this.chain
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        try {
          const st = await fs.stat(file);
          if (st.size > MAX_BYTES) await fs.rename(file, `${file}.old`);
        } catch {
          /* 檔案不存在 */
        }
        await fs.appendFile(file, line + '\n', 'utf8');
      })
      .catch(() => {
        /* 日誌失敗不影響主流程 */
      });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

function describeCause(cause: unknown): unknown {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return String(cause).slice(0, STDERR_SNIPPET);
}

export const log = new Logger();
