import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendLine } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import type { OpLogEntry } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';

export class OpLog {
  private readonly file: string;
  constructor(ws: Workspace) { this.file = path.join(ws.internalDir, 'log.jsonl'); }
  async record(entry: Omit<OpLogEntry, 'at'>): Promise<void> {
    try { await appendLine(this.file, JSON.stringify({ ...entry, at: new Date().toISOString() })); }
    catch { log.warn('操作紀錄寫入失敗'); }
  }
  async recent(n = 50): Promise<OpLogEntry[]> {
    const count = Number.isFinite(n) ? Math.max(0, Math.min(200, Math.floor(n))) : 50;
    if (!count) return [];
    let text: string;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
    const rows = text.split('\n');
    const result: OpLogEntry[] = [];
    for (let i = rows.length - 1; i >= 0 && result.length < count; i--) {
      if (!rows[i]!.trim()) continue;
      try {
        const entry: unknown = JSON.parse(rows[i]!);
        if (entry && typeof entry === 'object' && 'at' in entry && typeof entry.at === 'string' && 'action' in entry && typeof entry.action === 'string') result.push(entry as OpLogEntry);
      } catch { log.warn('略過損壞的操作紀錄'); }
    }
    return result;
  }
}
