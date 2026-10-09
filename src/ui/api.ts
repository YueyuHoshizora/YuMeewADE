// UI → 核心的 HTTP 包裝。桌面版與網頁版同一份。

import type { ApiError, Bootstrap, ChatRow, MergeResult, QueueItem, Roles, Task, TaskPatch, WorktreeStatus } from '../shared/types.ts';

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, body: ApiError | null) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error ?? 'unknown';
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiFailure(res.status, json as ApiError | null);
  return json as T;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const api = {
  bootstrap: () => call<Bootstrap>('GET', '/api/bootstrap'),
  roles: () => call<Roles>('GET', '/api/roles'),
  tasks: (project: string) => call<Task[]>('GET', `/api/tasks?${q({ project })}`),
  chatLog: (project: string, task: string) => call<ChatRow[]>('GET', `/api/chat/log?${q({ project, task })}`),
  createProject: (name: string) => call<unknown>('POST', '/api/projects', { name }),
  createTask: (project: string, title: string, role: string) => call<Task>('POST', '/api/tasks', { project, title, role }),
  updateTask: (project: string, task: string, patch: TaskPatch) => call<Task>('POST', '/api/task/update', { project, task, patch }),
  send: (project: string, task: string, text: string, opts: { cli?: string; model?: string; effort?: string }) =>
    call<{ request: string; queued: boolean }>('POST', '/api/chat/send', { project, task, text, ...opts }),
  stop: (project: string, task: string) => call<{ stopped: boolean }>('POST', '/api/chat/stop', { project, task }),
  removeQueued: (project: string, task: string, request: string) => call<QueueItem[]>('POST', '/api/chat/queue/remove', { project, task, request }),
  worktreeStatus: (project: string, task: string) => call<WorktreeStatus>('GET', `/api/worktree/status?${q({ project, task })}`),
  worktreeDiff: (project: string, task: string) => call<{ diff: string; truncated: boolean }>('GET', `/api/worktree/diff?${q({ project, task })}`),
  worktreeCreate: (project: string, task: string) => call<WorktreeStatus>('POST', '/api/worktree/create', { project, task }),
  worktreeMerge: (project: string, task: string) => call<MergeResult>('POST', '/api/worktree/merge', { project, task }),
  worktreeRemove: (project: string, task: string) => call<{ removed: boolean }>('POST', '/api/worktree/remove', { project, task }),
  streamUrl: (project: string, task: string) => `/api/chat/stream?${q({ project, task })}`,
};
