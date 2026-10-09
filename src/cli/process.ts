// 子行程共用：環境白名單、找執行檔、逐行 JSON 解析、SIGTERM 停止。只有 src/cli/ 可以 spawn CLI。

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log, STDERR_SNIPPET } from '../shared/log.ts';
import type { RunOutcome } from './provider.ts';

const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH'];
/** CLI 自己的設定目錄指標（不是憑證，但沒有它 CLI 會找不到登入狀態）。 */
const CLI_HOME_ENV = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

/** 只放行基本變數＋LC_*／XDG_*＋設定檔指定的名稱（安全節 8）。 */
export function minimalEnv(passthrough: string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (BASE_ENV.includes(k) || CLI_HOME_ENV.includes(k) || k.startsWith('LC_') || k.startsWith('XDG_') || passthrough.includes(k)) out[k] = v;
  }
  out['GIT_TERMINAL_PROMPT'] = '0';
  return out;
}

const cache = new Map<string, { at: number; found: boolean }>();

/** 在 PATH 上找得到執行檔即視為可用；結果快取 30 秒。 */
export async function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const hit = cache.get(command);
  if (hit && Date.now() - hit.at < 5_000) return hit.found;
  const found = await locate(command, env);
  cache.set(command, { at: Date.now(), found });
  return found;
}

async function locate(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const exts = process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = path.isAbsolute(command) || command.includes(path.sep) ? [''] : (env['PATH'] ?? '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, command + ext) : command + ext;
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return true;
      } catch {
        /* 下一個 */
      }
    }
  }
  return false;
}

export interface LineProcess {
  stop(): void;
  done: Promise<RunOutcome>;
}

/**
 * 啟動 CLI，把 prompt 寫進 stdin，stdout 逐行交給 onLine（已 JSON.parse；壞行略過）。
 * 結束時 done resolve：exit 0 → ok；stop() → stopped；否則 reason 帶退出碼與 stderr 片段（只進日誌）。
 */
export function runLineProcess(opts: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; prompt: string; label: string }, onLine: (obj: Record<string, unknown>) => void): LineProcess {
  const { promise, resolve } = Promise.withResolvers<RunOutcome>();
  let child: ChildProcess;
  let stopped = false;
  let stderr = '';
  let settled = false;
  const finish = (o: RunOutcome) => {
    if (settled) return;
    settled = true;
    resolve(o);
  };
  try {
    child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    finish({ ok: false, stopped: false, reason: `spawn 失敗：${(err as Error).message}` });
    return { stop: () => undefined, done: promise };
  }
  log.info('CLI 啟動', { label: opts.label, pid: child.pid, args: redactArgs(opts.args) });
  child.on('error', (err) => finish({ ok: false, stopped, reason: `啟動失敗：${err.message}` }));
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(opts.prompt);
  let buf = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      try {
        onLine(JSON.parse(line) as Record<string, unknown>);
      } catch {
        log.warn('CLI 輸出非 JSON 行', { label: opts.label, head: line.slice(0, 80) });
      }
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < STDERR_SNIPPET) stderr += chunk;
  });
  child.on('close', (code, signal) => {
    if (buf.trim().startsWith('{')) {
      try {
        onLine(JSON.parse(buf.trim()) as Record<string, unknown>);
      } catch {
        /* 尾端不完整 */
      }
    }
    if (stopped) finish({ ok: false, stopped: true });
    else if (code === 0) finish({ ok: true, stopped: false });
    else finish({ ok: false, stopped: false, reason: `exit ${code ?? signal}: ${stderr.slice(0, STDERR_SNIPPET)}` });
  });
  return {
    stop: () => {
      if (stopped || settled) return;
      stopped = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5000).unref();
    },
    done: promise,
  };
}

/** 日誌只記旗標形狀：session id、路徑等帶值的旗標以 <…> 取代（安全節 8）。 */
const VALUE_FLAGS = new Set(['--resume', '--add-dir', '--model', '-m', '-c', '--effort', 'resume']);
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  let hide = false;
  for (const a of args) {
    if (hide) {
      out.push('<…>');
      hide = false;
      continue;
    }
    out.push(a.length > 40 ? a.slice(0, 40) + '…' : a);
    hide = VALUE_FLAGS.has(a);
  }
  return out;
}
