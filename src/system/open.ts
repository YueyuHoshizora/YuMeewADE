import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';

/**
 * argv for the platform's file manager. Paths reach this from AI replies, so only plain folders are opened: opening a
 * file hands it to its default handler, which executes scripts and executables (`open run.sh`, `explorer setup.bat`),
 * and on macOS a folder with an extension may be an application bundle. Those are revealed in their folder instead.
 */
export function openCommand(platform: NodeJS.Platform, target: string, directory: boolean, reveal = false): { command: string; args: string[] } {
  const show = reveal || !directory || platform === 'darwin' && path.extname(target) !== '';
  if (platform === 'darwin') return { command: 'open', args: [...(show ? ['-R'] : []), target] };
  if (platform === 'win32') return { command: 'explorer', args: [show ? `/select,${target}` : target] };
  return { command: 'xdg-open', args: [show ? path.dirname(target) : target] };
}

export async function openPath(target: string, reveal = false): Promise<void> {
  if (!path.isAbsolute(target) || target.includes('\0')) throw new AppError('bad_request');
  let directory: boolean;
  try { directory = (await fs.stat(target)).isDirectory(); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found');
    throw cause;
  }
  const { command, args } = openCommand(process.platform, target, directory, reveal);
  // Validate existence before spawning; argv never passes through a shell.
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  child.once('error', (cause) => reject(new AppError('internal', undefined, { cause })));
  child.once('close', (code) => code === 0 ? resolve() : reject(new AppError('internal')));
  await promise;
}
