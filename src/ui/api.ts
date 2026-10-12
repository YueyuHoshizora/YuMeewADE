import type { ApiError, AppState, NewProjectInput, Project, NewTaskInput, Task, StartInput, StartResult, SendInput, SendResult, MergePreview, MergeResult, SettingsPatch, Settings, RoleInput, Roles, AiInfo, OpLogEntry, UploadResult } from '../shared/types.ts';

export class ApiFailure extends Error {
  status: number;
  body: ApiError & { conflicts?: string[] };
  constructor(status: number, body: ApiError & { conflicts?: string[] }) {
    super(body.message); this.status = status; this.body = body;
  }
}
/** The core could not be reached at all (core stopped, network down); distinct from an error the core reported. */
export class NetworkFailure extends Error {}
export async function coreFetch(path: string, init: RequestInit): Promise<Response> {
  try { return await fetch(path, init); } catch { throw new NetworkFailure(); }
}
async function decode<T>(res: Response): Promise<T> {
  let data: unknown;
  // A reply that is not the core's JSON (e.g. a proxy error page) is an internal failure, not a lost connection.
  try { data = await res.json(); } catch { throw new ApiFailure(res.ok ? 502 : res.status, { error: 'internal', message: '' }); }
  if (!res.ok) throw new ApiFailure(res.status, data as ApiError);
  return data as T;
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  return decode<T>(await coreFetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
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
  workspace: (root: string) => request<{ root: string }>('/api/workspace', { root }),
  refreshAi: (ai: string) => request<AiInfo>('/api/ai/refresh', { ai }),
  updateAi: (ai: string) => request<{ before: string; after: string; info: AiInfo }>('/api/ai/update', { ai }),
  log: () => request<OpLogEntry[]>('/api/log?n=100'),
  async upload(project: string, file: File, scope = 'quickstart'): Promise<UploadResult> {
    return decode<UploadResult>(await coreFetch(query('/api/upload', { project, name: file.name, scope }), { method: 'POST', body: file }));
  },
};
