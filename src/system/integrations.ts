import { spawn } from 'node:child_process';
import { captureCommand, findExecutable, minimalEnv } from '../cli/process.ts';
import { AppError } from '../shared/errors.ts';
import type { ExecutionService } from './commands.ts';

export interface NativeTool { command: string; args: string[]; }
export interface IntegrationOptions { ide?: NativeTool; terminal?: NativeTool; browser?: NativeTool; envPassthrough?: string[]; beforeStart?: (project: string, task: string) => Promise<void>; }

export function loopbackUrl(value: string, inspector = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('bad_request'); }
  if (value.length > 4096 || /[\0\r\n]/u.test(value) || url.username || url.password || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !(inspector ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol) || !url.port || Number(url.port) < 1 || Number(url.port) > 65535) throw new AppError('bad_request');
  return url;
}
const quotePosix = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

export class IntegrationService {
  private readonly execution: ExecutionService;
  private readonly options: IntegrationOptions;
  constructor(execution: ExecutionService, options: IntegrationOptions = {}) { this.execution = execution; this.options = options; }
  private async launch(tool: NativeTool, cwd: string, replacements: Record<string, string>, detached = false): Promise<void> {
    if (!tool.command || tool.command.includes('\0') || !Array.isArray(tool.args) || tool.args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new AppError('bad_request');
    const args = tool.args.map(arg => arg.replace(/\{(cwd|url|command)\}/gu, (match, key: string) => replacements[key] ?? match));
    if (detached) {
      const env = minimalEnv(this.options.envPassthrough ?? []);
      const command = await findExecutable(tool.command, env, cwd);
      if (!command) throw new AppError('unavailable', 'cli_unavailable', { field: 'terminal' });
      const child = spawn(command, args, { cwd, env, detached: true, stdio: 'ignore' });
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      child.once('error', () => reject(new AppError('unavailable', 'cli_unavailable', { field: 'terminal' })));
      child.once('spawn', () => { child.unref(); resolve(); });
      await promise;
      return;
    }
    const result = await captureCommand({ command: tool.command, args, cwd, env: minimalEnv(this.options.envPassthrough ?? []), timeoutMs: 15000, maxOutputBytes: 4096 });
    if (!result.ok) throw new AppError('unavailable', 'cli_unavailable', { field: 'native tool' });
  }
  async ide(project: string, task: string): Promise<void> {
    const cwd = await this.execution.cwd(project, task);
    if (!this.options.ide) throw new AppError('unavailable', 'cli_unavailable', { field: 'IDE' });
    if (!this.options.ide.args.some(a => a.includes('{cwd}'))) throw new AppError('bad_request');
    await this.launch(this.options.ide, cwd, { cwd });
  }
  async preview(project: string, task: string, value: string): Promise<void> {
    const cwd = await this.execution.cwd(project, task);
    const url = loopbackUrl(value).href;
    await this.browser(cwd, url);
  }
  private async browser(cwd: string, url: string): Promise<void> {
    const tool = this.options.browser ?? (process.platform === 'darwin' ? { command: 'open', args: ['{url}'] } : process.platform === 'win32' ? { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', '{url}'] } : { command: 'xdg-open', args: ['{url}'] });
    if (!tool.args.some(a => a.includes('{url}'))) throw new AppError('bad_request');
    await this.launch(tool, cwd, { url, cwd });
  }
  async debug(project: string, task: string, value: string, target: 'browser' | 'ide' = 'browser'): Promise<void> {
    const cwd = await this.execution.cwd(project, task);
    const inspector = loopbackUrl(value, true);
    if (!/^\/[a-f0-9-]+$/u.test(inspector.pathname) || inspector.search || inspector.hash || inspector.protocol !== 'ws:') throw new AppError('bad_request');
    if (target === 'ide') {
      if (!this.options.ide?.args.some(a => a.includes('{url}'))) throw new AppError('unavailable', 'cli_unavailable', { field: 'IDE debugger' });
      await this.launch(this.options.ide, cwd, { cwd, url: inspector.href });
      return;
    }
    // DevTools is opened in the OS browser, never navigates the application renderer.
    const url = `devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=${encodeURIComponent(inspector.host + inspector.pathname)}`;
    const tool = this.options.browser ?? (process.platform === 'darwin' ? { command: 'open', args: ['-a', 'Google Chrome', '--args', '{url}'] } : { command: process.platform === 'win32' ? 'chrome.exe' : 'chromium', args: ['{url}'] });
    await this.launch(tool, cwd, { cwd, url });
  }
  async terminal(project: string, task: string, command = ''): Promise<void> {
    if (command.length > 8192 || /[\0\r\n]/u.test(command)) throw new AppError('bad_request');
    await this.options.beforeStart?.(project, task);
    const cwd = await this.execution.cwd(project, task);
    if (this.options.terminal) {
      if (!this.options.terminal.args.some(a => a.includes('{cwd}')) || (command && !this.options.terminal.args.some(a => a.includes('{command}')))) throw new AppError('bad_request');
      await this.launch(this.options.terminal, cwd, { cwd, command }, true);
      return;
    }
    if (process.platform === 'darwin') {
      const shell = `cd -- ${quotePosix(cwd)}${command ? ' && ' + command : ''}`;
      // argv is passed as AppleScript data; neither folder nor command can inject AppleScript.
      await this.launch({ command: 'osascript', args: ['-e', 'on run argv\n tell application "Terminal"\n activate\n do script (item 1 of argv)\n end tell\nend run', shell] }, cwd, {});
    } else if (process.platform === 'win32') {
      await this.launch({ command: 'wt.exe', args: windowsTerminalArgs(cwd, command) }, cwd, {});
    } else {
      const env = minimalEnv(this.options.envPassthrough ?? []);
      const terminal = await findExecutable('x-terminal-emulator', env, cwd);
      if (!terminal) throw new AppError('unavailable', 'cli_unavailable', { field: 'terminal' });
      const script = `cd -- ${quotePosix(cwd)} && ${command ? command + '; ' : ''}exec "\${SHELL:-/bin/sh}"`;
      await this.launch({ command: terminal, args: ['-e', 'sh', '-c', script] }, cwd, {}, true);
    }
  }
}

/**
 * Windows Terminal splits its own command line into subcommands at every `;`, quoted or not; `\;` is its literal
 * semicolon. Without escaping, `npm i; npm test` (or a folder with `;` in its name) would open as two wt actions.
 */
export function windowsTerminalArgs(cwd: string, command: string): string[] {
  const literal = (value: string) => value.replaceAll(';', '\\;');
  return ['-d', literal(cwd), 'powershell.exe', '-NoExit', '-Command', command ? literal(command) : '$null'];
}
