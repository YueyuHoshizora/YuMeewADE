import { randomUUID } from 'node:crypto';
import type { CliProvider, CliRun } from '../cli/provider.ts';
import type { ChatStore } from './store.ts';
import type { WorktreeService } from '../git/worktree.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { SettingsStore } from '../ledger/settings.ts';
import type { Config } from '../shared/config.ts';
import type { Ask, ChatEvent, ChatRow, ReviewCapability, ReviewInput, ReviewResult, TurnUsage } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';

interface Dependencies {
  providers: Record<string, CliProvider>; store: ChatStore; worktree: WorktreeService;
  tasks: TaskLedger; settings: SettingsStore; limits: Config['limits'];
  onChanged: (project: string, task: string) => void;
  isRunning: (project: string, task: string) => boolean;
  publish: (project: string, task: string, event: ChatEvent) => void;
}

/** Review never reads/writes conversation metadata or resumes a writing session. */
export class ReviewService {
  private readonly running = new Map<string, { run?: CliRun; stopped: boolean; done?: Promise<ReviewResult> }>();
  private closed = false;
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) { this.deps = deps; }
  capabilities(): Record<string, ReviewCapability> {
    return Object.fromEntries(Object.entries(this.deps.providers).map(([ai, provider]) => [ai, {
      supported: provider.supportsReadonly === true,
      enforcement: provider.supportsReadonly ? provider.readonlyEnforcement ?? 'unsupported' : 'unsupported',
    }]));
  }
  isBusy(project?: string, task?: string): boolean {
    if (project === undefined) return this.running.size > 0;
    if (task !== undefined) return this.running.has(JSON.stringify([project, task]));
    return [...this.running.keys()].some(key => (JSON.parse(key) as string[])[0] === project);
  }
  stop(project: string, task: string): boolean {
    const entry = this.running.get(JSON.stringify([project, task]));
    if (!entry) return false;
    entry.stopped = true;
    entry.run?.stop();
    return true;
  }
  private async append(project: string, task: string, row: ChatRow): Promise<void> {
    await this.deps.store.append(project, task, row);
    this.deps.publish(project, task, { event: 'row', data: row });
  }
  run(project: string, task: string, input: ReviewInput): Promise<ReviewResult> {
    const key = JSON.stringify([project, task]);
    if (this.closed) return Promise.reject(new AppError('unavailable'));
    if (this.deps.isRunning(project, task) || this.running.has(key) || this.running.size >= this.deps.limits.concurrentRuns) return Promise.reject(new AppError('conflict'));
    const provider = this.deps.providers[input.ai];
    if (!provider?.supportsReadonly || !provider.readonlyEnforcement) return Promise.reject(new AppError('bad_request', 'cli_unsupported'));
    if (!input.text.trim() || input.text.length > this.deps.limits.promptChars) return Promise.reject(new AppError('bad_request'));
    const entry: { run?: CliRun; stopped: boolean; done?: Promise<ReviewResult> } = { stopped: false };
    this.running.set(key, entry);
    entry.done = (async () => {
      const request = randomUUID(); const started = Date.now();
      let text = ''; let session: string | undefined; let usage: TurnUsage | undefined; let asks: Ask[] | undefined;
      let failure = false; let timer: NodeJS.Timeout | undefined; let appended = false;
      try {
        const record = await this.deps.tasks.get(project, task);
        const cwd = record.workspace === 'isolated' && record.workdir ? record.workdir : await this.deps.worktree.bodyPath(project);
        const settings = await this.deps.settings.get();
        if (!await provider.available()) throw new AppError('bad_request', 'cli_unavailable');
        if (entry.stopped || this.closed) throw new AppError('conflict');
        const selection = { ...(input.model === undefined ? {} : { model: input.model }), ...(input.effort === undefined ? {} : { effort: input.effort }) };
        await this.append(project, task, { at: new Date().toISOString(), role: 'user', to: input.ai, text: input.text, ...selection, request });
        appended = true;
        if (entry.stopped || this.closed) throw new AppError('conflict');
        entry.run = provider.send({ prompt: `Review the workspace and report findings only. Do not change files.\n\n${input.text}`, cwd, readonly: true,
          ...selection, accountId: settings.activeAccounts[input.ai] ?? 'default' }, event => {
          if (event.type === 'delta') text += event.text;
          else if (event.type === 'result') text = event.text;
          else if (event.type === 'session') session = event.id;
          else if (event.type === 'usage') usage = event.usage;
          else if (event.type === 'asks') asks = event.asks;
          else if (event.type === 'error') failure = true;
        });
        timer = setTimeout(() => { entry.stopped = true; entry.run?.stop(); }, this.deps.limits.runSeconds * 1000);
        const outcome = await entry.run.done;
        failure ||= !outcome.ok;
        entry.stopped ||= outcome.stopped;
        await this.append(project, task, { at: new Date().toISOString(), role: 'assistant', ai: input.ai, text,
          ...selection, request, ms: Date.now() - started, ...(usage ? { usage } : {}),
          ...(failure ? { error: 'review_failed' } : {}), ...(entry.stopped ? { stopped: true } : {}), ...(asks ? { asks } : {}) });
        appended = false;
        return { request, text, ai: input.ai, ...(session ? { session } : {}), ...(asks ? { asks } : {}), ok: !failure && !entry.stopped };
      } catch (error) {
        if (appended) await this.append(project, task, { at: new Date().toISOString(), role: 'assistant', ai: input.ai, text, request, ms: Date.now() - started, error: 'review_failed', ...(entry.stopped ? { stopped: true } : {}) });
        throw error;
      } finally {
        clearTimeout(timer); this.running.delete(key); this.deps.onChanged(project, task);
      }
    })();
    return entry.done;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.running.values()) { entry.stopped = true; entry.run?.stop(); }
    await Promise.allSettled([...this.running.values()].map(entry => entry.done));
  }
}
