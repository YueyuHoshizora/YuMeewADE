// 本地日誌：stderr＋檔案（超過 5 MiB 就搬成 .old 重開）。
// 規則：不寫環境變數、不寫提示全文、CLI stderr 只截前 500 字；本機日誌檢視器可讀既有堆疊。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import type { LogTail } from './types.ts';

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

export const LOG_TAIL_BYTES = 256 * 1024;
export const LOG_TAIL_LINES = 1000;

/** Defense in depth, not a guarantee that arbitrary log messages contain no secrets. */
export function redactLog(text: string, home = os.homedir()): string {
  if (home) {
    text = text.replaceAll(home, '~').replaceAll(JSON.stringify(home).slice(1, -1), '~');
  }
  return text
    .replace(/("(?:[^"]*(?:token|secret|password|credential|authorization|api[_-]?key)[^"]*)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_/-]{32,}\b/g, '[REDACTED]');
}

/** Reads only a fixed local file, without following log-file or parent-directory symlinks. */
export async function readLogTail(root: string): Promise<LogTail> {
  const realRoot = await fs.realpath(root);
  const directory = path.join(realRoot, '.yumeewade');
  let handle;
  try {
    if ((await fs.realpath(directory)) !== directory) return { text: '', truncated: false };
    handle = await fs.open(path.join(directory, 'yumeewade.log'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return { text: '', truncated: false };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { text: '', truncated: false };
    const length = Math.min(stat.size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const start = stat.size - length;
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) { const newline = text.indexOf('\n'); text = newline < 0 ? '' : text.slice(newline + 1); }
    const lines = text.replace(/\n$/, '').split('\n');
    const truncated = start > 0 || lines.length > LOG_TAIL_LINES;
    text = redactLog(lines.slice(-LOG_TAIL_LINES).join('\n'));
    // JSON serialization may expand escaping, but the source and returned text stay bounded.
    if (Buffer.byteLength(text) > LOG_TAIL_BYTES) text = Buffer.from(text).subarray(0, LOG_TAIL_BYTES).toString('utf8').replace(/\uFFFD$/, '');
    return { text, truncated };
  } finally { await handle.close(); }
}
