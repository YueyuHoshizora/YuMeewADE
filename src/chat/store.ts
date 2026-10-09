// 對話檔案：{id}.jsonl（只追加）、{id}.json（session／已讀）、{id}.queue.json（隊列）。

import { promises as fs } from 'node:fs';
import type { Workspace } from '../ledger/workspace.ts';
import { appendLine, readJson, writeJson } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import type { ChatMeta, ChatRow, QueueItem } from '../shared/types.ts';

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
    return { sessions: meta.sessions ?? {}, seen: meta.seen ?? {} };
  }

  writeMeta(project: string, task: string, meta: ChatMeta): Promise<void> {
    return writeJson(this.ws.chatFile(project, task, 'json'), meta);
  }

  readQueue(project: string, task: string): Promise<QueueItem[]> {
    return readJson<QueueItem[]>(this.ws.chatFile(project, task, 'queue.json'), []);
  }

  writeQueue(project: string, task: string, queue: QueueItem[]): Promise<void> {
    return writeJson(this.ws.chatFile(project, task, 'queue.json'), queue);
  }
}
