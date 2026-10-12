import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runLineProcess, captureCommand, windowsCommandLine, findExecutable, minimalEnv, terminateTree } from './process.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Windows 的環境變數名稱不分大小寫：Path／SystemRoot 依白名單寫法放行，其他平台仍逐字比對', () => {
  const source = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', Codex_Home: 'C:\\c', My_Var: 'x', lc_all: 'C', OPENAI_API_KEY: 'secret' };
  assert.deepEqual(minimalEnv(['MY_VAR'], source, 'win32'), { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', CODEX_HOME: 'C:\\c', MY_VAR: 'x', lc_all: 'C', GIT_TERMINAL_PROMPT: '0' });
  assert.deepEqual(minimalEnv(['MY_VAR'], source, 'linux'), { SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', GIT_TERMINAL_PROMPT: '0' });
  // A passthrough entry naming a built-in variable in another case does not rename it.
  assert.deepEqual(minimalEnv(['Path', 'node_options'], { PATH: 'C:\\bin', Node_Options: '--x' }, 'win32'), { PATH: 'C:\\bin', NODE_OPTIONS: '--x', GIT_TERMINAL_PROMPT: '0' });
});

test('a malformed JSON line from a CLI is logged without its content, which may echo the prompt or a credential', { skip: process.platform === 'win32' }, async () => {
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const run = runLineProcess({ command: '/bin/sh', args: ['-c', 'printf "{password=sk-SECRET prompt=PRIVATE\\n"'], cwd: process.cwd(), env: process.env, prompt: '', label: 'redaction-test' }, () => assert.fail('not JSON'));
    await run.done;
  } finally { process.stderr.write = write; }
  const warning = written.find(line => line.includes('redaction-test') && line.includes('"level":"warn"'));
  assert.ok(warning, 'the malformed line is still reported');
  assert.doesNotMatch(warning, /SECRET|PRIVATE/);
});

// 真實行程樹／系統 PID 不受 fake clock 控制，以短輪詢等 OS 回收。
test('停止會終止持有 stdout 的孫行程並及時完成', { skip: process.platform === 'win32', timeout: 8000 }, async () => {
  let pid = 0;
  const run = runLineProcess({ command: '/bin/sh', args: ['-c', 'sleep 300 & p=$!; printf "{\\"pid\\":%s}\\n" "$p"; wait'], cwd: process.cwd(), env: process.env, prompt: '', label: 'test' }, (row) => { pid = Number(row['pid']); });
  for (let i = 0; i < 100 && !pid; i++) await delay(10);
  assert.ok(pid > 0);
  run.stop();
  assert.equal((await run.done).stopped, true);
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (err) { assert.equal((err as NodeJS.ErrnoException).code, 'ESRCH'); return; }
    await delay(10);
  }
  assert.fail('孫行程仍存活');
});

test('非推論指令逾時也會停止整個行程樹', { skip: process.platform === 'win32', timeout: 8000 }, async () => {
  const result = await captureCommand({ command: '/bin/sh', args: ['-c', 'sleep 300 & wait'], timeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'command timeout');
});

test('a group member ignoring SIGTERM is still killed after the leader exits and the stop is cancelled', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  // Ignored signals stay ignored across exec, so this sleep survives SIGTERM; the shell itself dies on it.
  const child = spawn('/bin/sh', ['-c', '(trap "" TERM; exec sleep 300) & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = Number(await new Promise<string>(resolve => child.stdout!.once('data', data => resolve(String(data)))));
  assert.ok(pid > 0);
  const cancel = terminateTree(child, () => undefined);
  child.once('exit', () => cancel());
  for (let i = 0; i < 90; i++) {
    try { process.kill(pid, 0); } catch (err) { assert.equal((err as NodeJS.ErrnoException).code, 'ESRCH'); return; }
    await delay(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  assert.fail('the member that ignored SIGTERM is still alive');
});

test('沒有換行的超大輸出會失敗而不是無限制累積', { timeout: 8000 }, async () => {
  const run = runLineProcess({ command: process.execPath, args: ['-e', 'process.stdout.write(\"x\".repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, prompt: '', label: 'limit-test' }, () => assert.fail('不應解析為 JSON'));
  const outcome = await run.done;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopped, false);
  assert.equal(outcome.reason, 'CLI line output limit exceeded');
});

test('Windows 命令列正確處理空白、引號、反斜線及 cmd 特殊字元', () => {
  assert.equal(windowsCommandLine('C:\\Program Files\\codex.cmd', ['a b']), '\"C:\\Program^ Files\\codex.cmd ^^^\"a^^^ b^^^\"\"');
  assert.equal(windowsCommandLine('tool.exe', ['']), '\"tool.exe ^\"^\"\"');
  assert.equal(windowsCommandLine('tool.exe', ['a\"b', 'a\\\\']), '\"tool.exe ^\"a\\^\"b^\" ^\"a\\\\\\\\^\"\"');
  assert.equal(windowsCommandLine('tool.cmd', ['()%!^\"<>&|']), '\"tool.cmd ^^^\"^^^(^^^)^^^%^^^!^^^^\\^^^\"^^^<^^^>^^^&^^^|^^^\"\"');
});

test('執行檔查找回傳完整路徑而不是布林值', async () => {
  assert.equal(await findExecutable(process.execPath), process.execPath);
  assert.equal(await findExecutable('yumeewade-missing-executable', { PATH: '' }), null);
});

test('relative and empty PATH entries use effective cwd with separate cache entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'executable-cwd-'));
  try {
    for (const folder of ['a', 'b']) {
      await fs.mkdir(path.join(dir, folder, 'bin'), { recursive: true });
      await fs.copyFile(process.execPath, path.join(dir, folder, 'bin', path.basename(process.execPath)));
      await fs.copyFile(process.execPath, path.join(dir, folder, path.basename(process.execPath)));
    }
    for (const folder of ['a', 'b']) {
      const cwd = path.join(dir, folder);
      assert.equal(await findExecutable(path.basename(process.execPath), { PATH: 'bin' }, cwd), path.join(cwd, 'bin', path.basename(process.execPath)));
      assert.equal(await findExecutable(path.basename(process.execPath), { PATH: '' }, cwd), path.join(cwd, path.basename(process.execPath)));
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
