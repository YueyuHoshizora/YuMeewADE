// 測試用：在 os.tmpdir() 建臨時工作區，結束後刪除。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../ledger/workspace.ts';

export async function withTmpWorkspace<T>(fn: (ws: Workspace, dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yumeewade-'));
  try {
    const ws = new Workspace(path.join(dir, 'root'));
    await ws.init();
    return await fn(ws, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
