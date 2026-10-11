import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import { AppError } from '../shared/errors.ts';
import { isInside } from '../shared/fsx.ts';

/** Metadata belongs to the ledger task, never the executable source tree. */
export async function debuggerMetadataFile(ws: Workspace, tasks: TaskLedger, project: string, task: string): Promise<string> {
  const taskFile = ws.taskFile(project, task);
  const root = await fs.realpath(ws.root);
  const relative = path.relative(ws.root, path.dirname(taskFile));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new AppError('bad_request');
  let directory = root;
  for (const component of relative.split(path.sep)) {
    directory = path.join(directory, component);
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isInside(root, await fs.realpath(directory))) throw new AppError('bad_request');
  }
  const ledgerTask = path.join(directory, path.basename(taskFile));
  const taskStat = await fs.lstat(ledgerTask);
  if (taskStat.isSymbolicLink() || !taskStat.isFile()) throw new AppError('bad_request');
  await tasks.get(project, task);
  const file = path.join(directory, `${task}.debugger.json`);
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new AppError('bad_request');
  return file;
}
