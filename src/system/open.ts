import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';

export async function openPath(target: string, reveal = false): Promise<void> {
  if (!path.isAbsolute(target) || target.includes('\0')) throw new AppError('bad_request');
  try { await fs.stat(target); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('not_found');
    throw cause;
  }
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  const args = platform === 'darwin' ? [...(reveal ? ['-R'] : []), target]
    : platform === 'win32' ? [reveal ? `/select,${target}` : target]
    : [reveal ? path.dirname(target) : target];
  // Validate existence before spawning; argv never passes through a shell.
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  child.once('error', (cause) => reject(new AppError('internal', undefined, { cause })));
  child.once('close', (code) => code === 0 ? resolve() : reject(new AppError('internal')));
  await promise;
}
