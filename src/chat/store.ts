// 對話檔案：{id}.jsonl（只追加）、{id}.json（session／已讀）、{id}.queue.json（隊列）。

import { promises as fs } from 'node:fs';
import type { Workspace } from '../ledger/workspace.ts';
import { appendLine, readJson, writeJson } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import type { ChatRow, QueueItem } from '../shared/types.ts';
export interface ChatMeta {
  sessions: Record<string, string>;
  models: Record<string, string>;
  seen: Record<string, string>;
}

export class ChatStore {
  private readonly ws: Workspace;
  constructor(ws: Workspace) {
    this.ws = ws;
  }

  async readLog(project: string, task: string): Promise<ChatRow[]> {
    let text: string;
    try {
      text = await fs.readFile(this.ws.chatFile(project, task, 'jsonl'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const rows: ChatRow[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        rows.push(JSON.parse(line) as ChatRow);
      } catch {
        log.warn('略過壞掉的對話行', { project, task });
      }
    }
    return rows;
  }

  append(project: string, task: string, row: ChatRow): Promise<void> {
    return appendLine(this.ws.chatFile(project, task, 'jsonl'), JSON.stringify(row));
  }

  async readMeta(project: string, task: string): Promise<ChatMeta> {
    const meta = await readJson<Partial<ChatMeta>>(this.ws.chatFile(project, task, 'json'), {});
    return { sessions: meta.sessions ?? {}, models: meta.models ?? {}, seen: meta.seen ?? {} };
  }

  writeMeta(project: string, task: string, meta: ChatMeta): Promise<void> {
    return writeJson(this.ws.chatFile(project, task, 'json'), meta);
  }

  readQueue(project: string, task: string): Promise<QueueItem[]> {
    return readJson<QueueItem[]>(this.ws.chatFile(project, task, 'queue.json'), []);
  }

  /**
   * 讀改寫隊列；同一作業的修改串行化，避免入隊與出隊同時 read→write 互相蓋掉。
   * mutate 回傳新的隊列（或 null 代表不寫）。
   */
  updateQueue(project: string, task: string, mutate: (queue: QueueItem[]) => QueueItem[] | null): Promise<QueueItem[]> {
    const key = `${project}\u0000${task}`;
    const prev = this.queueLocks.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      const queue = await this.readQueue(project, task);
      const next = mutate(queue);
      if (next === null) return queue;
      await writeJson(this.ws.chatFile(project, task, 'queue.json'), next);
      return next;
    });
    // 失敗也要讓後續的鎖繼續
    this.queueLocks.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  private readonly queueLocks = new Map<string, Promise<void>>();
}
