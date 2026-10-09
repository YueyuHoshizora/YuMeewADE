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

const cache = new Map<string, { at: number; found: string | null }>();

/** 在 PATH 上找得到執行檔即視為可用；結果快取 5 秒。 */
export async function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const key = JSON.stringify([command, env['PATH'], env['PATHEXT']]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5_000) return hit.found;
  const found = await locate(command, env);
  cache.set(key, { at: Date.now(), found });
  return found;
}

async function locate(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const exts = process.platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const dirs = path.isAbsolute(command) || command.includes(path.sep) ? [''] : (env['PATH'] ?? '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, command + ext) : command + ext;
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return path.resolve(candidate);
      } catch {
        /* 下一個 */
      }
    }
  }
  return null;
}

export interface LineProcess {
  stop(): void;
  done: Promise<RunOutcome>;
}

/** POSIX 使用獨立行程群組；Windows 交給系統工具終止整棵樹。 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', (err) => log.warn('CLI 行程樹停止失敗', { message: err.message }));
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, signal); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('CLI 行程樹停止失敗', { message: (err as Error).message });
  }
}

function terminateTree(child: ChildProcess, finish: () => void): () => void {
  signalTree(child, 'SIGTERM');
  const kill = setTimeout(() => signalTree(child, 'SIGKILL'), 3000);
  const bound = setTimeout(() => {
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    child.unref();
    finish();
  }, 3500);
  kill.unref(); bound.unref();
  return () => { clearTimeout(kill); clearTimeout(bound); };
}

/** 對齊 cross-spawn：cmd 引號與反斜線規則，npm shim 需要再次跳脫。 */
export function windowsCommandLine(command: string, args: string[]): string {
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const escapedCommand = command.replace(meta, '^$1');
  const doubleEscape = /\.(?:cmd|bat)$/i.test(command);
  const escapedArgs = args.map((arg) => {
    let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1');
    escaped = `"${escaped}"`.replace(meta, '^$1');
    if (doubleEscape) escaped = escaped.replace(meta, '^$1');
    return escaped;
  });
  return `"${[escapedCommand, ...escapedArgs].join(' ')}"`;
}

function spawnCli(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return spawn(process.env['ComSpec'] || 'cmd.exe', ['/d', '/s', '/c', windowsCommandLine(command, args)], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(command, args, options);
}

/**
 * 啟動 CLI，把 prompt 寫進 stdin，stdout 逐行交給 onLine（已 JSON.parse；壞行略過）。
 * 結束時 done resolve：exit 0 → ok；stop() → stopped；否則 reason 帶退出碼與 stderr 片段（只進日誌）。
 */
export function runLineProcess(opts: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; prompt: string; label: string }, onLine: (obj: Record<string, unknown>) => void): LineProcess {
  let run: LineProcess | undefined;
  let stopped = false;
  const done = findExecutable(opts.command, opts.env).then((command) => {
    if (stopped) return { ok: false, stopped: true };
    if (!command) return { ok: false, stopped: false, reason: 'CLI executable not found' };
    run = runResolvedLineProcess({ ...opts, command }, onLine);
    return run.done;
  });
  return { done, stop: () => { stopped = true; run?.stop(); } };
}

function runResolvedLineProcess(opts: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; prompt: string; label: string }, onLine: (obj: Record<string, unknown>) => void): LineProcess {
  const { promise, resolve } = Promise.withResolvers<RunOutcome>();
  let child: ChildProcess;
  let stopped = false;
  let stderr = '';
  let settled = false;
  let cancelStop: (() => void) | undefined;
  const finish = (o: RunOutcome) => {
    if (settled) return;
    settled = true;
    cancelStop?.();
    resolve(o);
  };
  try {
    child = spawnCli(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  } catch (err) {
    finish({ ok: false, stopped: false, reason: `spawn 失敗：${(err as Error).message}` });
    return { stop: () => undefined, done: promise };
  }
  log.info('CLI 啟動', { label: opts.label, pid: child.pid, args: redactArgs(opts.args) });
  child.on('error', (err) => finish({ ok: false, stopped, reason: `啟動失敗：${err.message}` }));
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(opts.prompt);
  let buf = '';
  let bufBytes = 0;
  let failure: string | undefined;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (settled || failure) return;
    let start = 0;
    while (start < chunk.length) {
      const idx = chunk.indexOf('\n', start);
      const part = chunk.slice(start, idx < 0 ? undefined : idx);
      bufBytes += Buffer.byteLength(part);
      if (bufBytes > 16 * 1024 * 1024) {
        failure = 'CLI line output limit exceeded';
        log.warn('CLI 輸出超過單行上限', { label: opts.label });
        buf = '';
        const reason = failure;
        cancelStop = terminateTree(child, () => finish({ ok: false, stopped: false, reason }));
        return;
      }
      buf += part;
      if (idx < 0) break;
      const line = buf.trim();
      buf = ''; bufBytes = 0; start = idx + 1;
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
    if (!failure && buf.trim().startsWith('{')) {
      try {
        onLine(JSON.parse(buf.trim()) as Record<string, unknown>);
      } catch {
        /* 尾端不完整 */
      }
    }
    if (failure) finish({ ok: false, stopped: false, reason: failure });
    else if (stopped) finish({ ok: false, stopped: true });
    else if (code === 0) finish({ ok: true, stopped: false });
    else finish({ ok: false, stopped: false, reason: `exit ${code ?? signal}: ${stderr.slice(0, STDERR_SNIPPET)}` });
  });
  return {
    stop: () => {
      if (stopped || settled || failure) return;
      stopped = true;
      cancelStop = terminateTree(child, () => finish({ ok: false, stopped: true }));
    },
    done: promise,
  };
}

/** 日誌只記旗標形狀：session id、路徑等帶值的旗標以 <…> 取代（安全節 8）。 */
const VALUE_FLAGS: Record<string, true> = { '--resume': true, '--add-dir': true, '--model': true, '-m': true, '-c': true, '--effort': true, resume: true, '-i': true };
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
    hide = VALUE_FLAGS[a] === true;
  }
  return out;
}

export interface CommandCapture {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason?: string;
}

/** 非推論指令（版本、模型目錄、更新）；不使用 shell，不記錄輸出。 */
export async function captureCommand(opts: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<CommandCapture> {
  const env = opts.env ?? minimalEnv([]);
  const command = await findExecutable(opts.command, env);
  if (!command) return { ok: false, stdout: '', stderr: '', reason: 'CLI executable not found' };
  const { promise, resolve } = Promise.withResolvers<CommandCapture>();
  let stdout = '';
  let stderr = '';
  let reason: string | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let cancelStop: (() => void) | undefined;
  const finish = (ok: boolean, failure?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cancelStop?.();
    resolve({ ok, stdout, stderr, ...(failure ? { reason: failure } : {}) });
  };
  let child: ChildProcess;
  try {
    child = spawnCli(command, opts.args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  } catch (err) {
    finish(false, `spawn 失敗：${(err as Error).message}`);
    return promise;
  }
  const terminate = (failure: string) => {
    if (reason || settled) return;
    reason = failure;
    cancelStop = terminateTree(child, () => finish(false, failure));
  };
  timer = setTimeout(() => terminate('command timeout'), opts.timeoutMs);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length + chunk.length > 32 * 1024 * 1024) terminate('command output limit exceeded');
    else stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_SNIPPET);
  });
  child.on('error', (err) => finish(false, `啟動失敗：${err.message}`));
  child.on('close', (code, signal) => {
    if (reason) finish(false, reason);
    else if (code === 0) finish(true);
    else finish(false, `exit ${code ?? signal}`);
  });
  return promise;
}
