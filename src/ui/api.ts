import type { ApiError, AppState, NewProjectInput, Project, NewTaskInput, Task, StartInput, StartResult, SendInput, SendResult, MergePreview, MergeResult, SettingsPatch, Settings, RoleInput, Roles, AiInfo, OpLogEntry, UploadResult } from '../shared/types.ts';

export class ApiFailure extends Error {
  status: number;
  body: ApiError & { conflicts?: string[] };
  constructor(status: number, body: ApiError & { conflicts?: string[] }) {
    super(body.message); this.status = status; this.body = body;
  }
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json() as T;
  if (!res.ok) throw new ApiFailure(res.status, data as ApiError);
  return data;
}
export const query = (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`;
export const api = {
  state: () => request<AppState>('/api/state'),
  createProject: (input: NewProjectInput) => request<Project>('/api/project/new', input),
  createTask: (project: string, input: NewTaskInput) => request<Task>('/api/task/new', { project, ...input }),
  start: (input: StartInput) => request<StartResult>('/api/start', input),
  send: (input: SendInput) => request<SendResult>('/api/chat/send', input),
  preview: (project: string, task: string) => request<MergePreview | null>(query('/api/task/preview', { project, task })),
  diff: (project: string, task: string) => request<{ diff: string; truncated: boolean }>(query('/api/task/diff', { project, task })),
  merge: (project: string, task: string) => request<MergeResult>('/api/task/merge', { project, task }),
  settings: (patch: SettingsPatch) => request<Settings>('/api/settings', patch),
  roles: (roles: RoleInput[]) => request<Roles>('/api/roles', { roles }),
  refreshAi: (ai: string) => request<AiInfo>('/api/ai/refresh', { ai }),
  updateAi: (ai: string) => request<{ before: string; after: string; info: AiInfo }>('/api/ai/update', { ai }),
  log: () => request<OpLogEntry[]>('/api/log?n=100'),
  async upload(project: string, file: File): Promise<UploadResult> {
    const res = await fetch(query('/api/upload', { project, name: file.name }), { method: 'POST', body: file });
    const data = await res.json() as UploadResult;
    if (!res.ok) throw new ApiFailure(res.status, data as unknown as ApiError);
    return data;
  },
};
