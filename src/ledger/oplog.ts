import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendLine } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import type { OpLogEntry } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';

const TAIL_BYTES = 1024 * 1024;

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
    // The log is append-only and never rotated; the newest entries are all in the tail, so the read stays bounded.
    let text: string;
    try {
      const handle = await fs.open(this.file, 'r');
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, TAIL_BYTES);
        const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
        text = buffer.toString('utf8');
        // A cut-off first line is not an entry.
        if (length < size) text = text.slice(text.indexOf('\n') + 1);
      } finally { await handle.close(); }
    }
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
