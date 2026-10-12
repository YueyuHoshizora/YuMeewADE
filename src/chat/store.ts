// 對話檔案：{id}.jsonl（只追加）、{id}.json（session／已讀）、{id}.queue.json（隊列）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import { appendLine, readJson, writeJson, withFileLocks } from '../shared/fsx.ts';
import { isValidProjectName, isValidTaskId } from '../shared/names.ts';
import { log } from '../shared/log.ts';
import type { Busy, ChatRow, QueueItem } from '../shared/types.ts';
export interface ChatMeta {
  sessions: Record<string, string>;
  models: Record<string, string>;
  seen: Record<string, string>;
  /** Human attention only; independent of the AI handoff cursors in `seen`. */
  unread?: true;
  /** Session ownership; absent legacy entries belong to the implicit default account. */
  accounts?: Record<string, string>;
  /** `/fast` per AI; absent means the CLI's own configuration decides. */
  fast?: Record<string, boolean>;
  running?: Pick<Busy, 'request' | 'ai' | 'model' | 'effort' | 'startedAt'>;
}

export class ChatStore {
  private readonly ws: Workspace;
  private readonly logCache = new Map<string, {
    size: number; mtimeMs: number; ino: number; boundary: boolean; rows: ChatRow[];
  }>();
  constructor(ws: Workspace) {
    this.ws = ws;
  }

  async readLog(project: string, task: string): Promise<ChatRow[]> {
    const file = this.ws.chatFile(project, task, 'jsonl');
    let handle;
    try {
      handle = await fs.open(file, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logCache.delete(file);
        return [];
      }
      throw err;
    }
    try {
      const stat = await handle.stat();
      const cached = this.logCache.get(file);
      this.logCache.delete(file);
      if (cached && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        this.logCache.set(file, cached);
        return structuredClone(cached.rows);
      }
      // Only a complete previous line can be reused; otherwise the tail may
      // finish an incomplete JSON value (or UTF-8 character).
      const offset = cached && cached.ino === stat.ino && stat.size > cached.size && cached.boundary
        ? cached.size : 0;
      const bytes = Buffer.alloc(stat.size - offset);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, offset + length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const content = bytes.subarray(0, length);
      const rows = offset && cached ? [...cached.rows] : [];
      for (const line of content.toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        let row: unknown;
        try { row = JSON.parse(line); } catch { row = undefined; }
        // Valid JSON is not necessarily a row (`null`, a number, a stray object); every reader dereferences role/text.
        if (row && typeof row === 'object' && !Array.isArray(row) && ['user', 'assistant', 'event'].includes((row as ChatRow).role) && typeof (row as ChatRow).text === 'string') rows.push(row as ChatRow);
        else log.warn('略過壞掉的對話行', { project, task });
      }
      const entry = {
        size: offset + length, mtimeMs: stat.mtimeMs, ino: stat.ino,
        boundary: length === 0 ? offset === 0 || Boolean(cached?.boundary) : content.at(-1) === 0x0a,
        rows,
      };
      this.logCache.set(file, entry);
      if (this.logCache.size > 32) this.logCache.delete(this.logCache.keys().next().value!);
      return structuredClone(rows);
    } finally {
      await handle.close();
    }
  }

  append(project: string, task: string, row: ChatRow): Promise<void> {
    const file = this.ws.chatFile(project, task, 'jsonl');
    const metaFile = this.ws.chatFile(project, task, 'json');
    return withFileLocks([this.ws.projectFile(project), file, metaFile], async () => {
      await fs.access(this.ws.projectFile(project));
      await fs.access(this.ws.taskFile(project, task));
      await appendLine(file, JSON.stringify(row));
      if (row.role === 'assistant') {
        const meta = await this.readMeta(project, task);
        if (meta.running?.request === row.request) delete meta.running;
        meta.unread = true;
        await writeJson(metaFile, meta);
      }
    });
  }

  async readMeta(project: string, task: string): Promise<ChatMeta> {
    const meta = await readJson<Partial<ChatMeta>>(this.ws.chatFile(project, task, 'json'), {});
    return { sessions: meta.sessions ?? {}, models: meta.models ?? {}, seen: meta.seen ?? {}, ...(meta.unread === true ? { unread: true as const } : {}), ...(meta.accounts ? { accounts: meta.accounts } : {}), ...(meta.fast ? { fast: meta.fast } : {}), ...(meta.running ? { running: meta.running } : {}) };
  }

  writeMeta(project: string, task: string, meta: ChatMeta): Promise<void> {
    const file = this.ws.chatFile(project, task, 'json');
    return withFileLocks([this.ws.projectFile(project), file], async () => {
      await fs.access(this.ws.projectFile(project));
      await fs.access(this.ws.taskFile(project, task));
      // A running turn holds an older snapshot; it must not undo the human's read acknowledgement.
      const current = await this.readMeta(project, task);
      const next = { ...meta };
      if (current.unread) next.unread = true;
      else delete next.unread;
      await writeJson(file, next);
    });
  }

  markRead(project: string, task: string): Promise<void> {
    const file = this.ws.chatFile(project, task, 'json');
    return withFileLocks([this.ws.projectFile(project), file], async () => {
      await fs.access(this.ws.projectFile(project));
      await fs.access(this.ws.taskFile(project, task));
      const meta = await this.readMeta(project, task);
      if (!meta.unread) return;
      delete meta.unread;
      await writeJson(file, meta);
    });
  }

  readQueue(project: string, task: string): Promise<QueueItem[]> {
    return readJson<QueueItem[]>(this.ws.chatFile(project, task, 'queue.json'), []);
  }

  /**
   * 讀改寫隊列；同一作業的修改串行化，避免入隊與出隊同時 read→write 互相蓋掉。
   * mutate 回傳新的隊列（或 null 代表不寫）。
   */
  updateQueue(project: string, task: string, mutate: (queue: QueueItem[]) => QueueItem[] | null): Promise<QueueItem[]> {
    const file = this.ws.chatFile(project, task, 'queue.json');
    return withFileLocks([this.ws.projectFile(project), file], async () => {
      await fs.access(this.ws.projectFile(project));
      await fs.access(this.ws.taskFile(project, task));
      const queue = await this.readQueue(project, task);
      const next = mutate(queue);
      if (next === null) return queue;
      await writeJson(file, next);
      return next;
    });
  }

  /** 啟動只掃小型 meta，不讀整份對話；有 marker 才檢查最後已寫入的回覆。 */
  async recoverInterrupted(): Promise<{ project: string; task: string }[]> {
    const projects = await fs.readdir(this.ws.projectsDir, { withFileTypes: true });
    const pending: { project: string; task: string }[] = [];
    const unread: { project: string; task: string }[] = [];
    for (const project of projects) {
      if (!project.isDirectory() || !isValidProjectName(project.name)) continue;
      let entries: string[];
      try { entries = await fs.readdir(path.join(this.ws.projectDir(project.name), '.ai', 'chat')); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
      for (const entry of entries) {
        if (!entry.endsWith('.json') || entry.endsWith('.queue.json')) continue;
        const task = entry.slice(0, -5);
        if (isValidTaskId(task)) pending.push({ project: project.name, task });
      }
    }
    // 限制同時開檔數，避免大型工作區初始化耗盡資源。
    for (let offset = 0; offset < pending.length; offset += 8) {
      await Promise.all(pending.slice(offset, offset + 8).map(async ({ project, task }) => {
        const meta = await this.readMeta(project, task);
        const running = meta.running;
        if (running) {
          const rows = await this.readLog(project, task);
          if (!rows.some(row => row.role === 'assistant' && row.request === running.request)) {
            await this.append(project, task, { role: 'assistant', ai: running.ai, model: running.model ?? '', effort: running.effort ?? '', request: running.request, at: new Date().toISOString(), text: '', error: 'interrupted', ms: 0 });
          } else { delete meta.running; await this.writeMeta(project, task, meta); }
        }
        if ((await this.readMeta(project, task)).unread) unread.push({ project, task });
      }));
    }
    return unread;
  }
}
