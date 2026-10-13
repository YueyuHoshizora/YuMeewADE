import { randomUUID } from 'node:crypto';
import type { CliProvider, CliRun } from '../cli/provider.ts';
import type { ChatStore } from './store.ts';
import type { WorktreeService } from '../git/worktree.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { SettingsStore } from '../ledger/settings.ts';
import type { Config } from '../shared/config.ts';
import type { Ask, ChatEvent, ChatRow, ReviewCapability, ReviewInput, ReviewResult, RunningInfo, TurnUsage } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import type { ReviewHistory, ReviewFindingState, ReviewSnapshot } from '../shared/review-types.ts';
import { readJson, writeJson, withFileLocks } from '../shared/fsx.ts';
import { parseReviewOutput, reviewFingerprint, REVIEW_PROTOCOL } from './review-output.ts';

interface Dependencies {
  providers: Record<string, CliProvider>; store: ChatStore; worktree: WorktreeService;
  tasks: TaskLedger; settings: SettingsStore; limits: Config['limits'];
  ws: Workspace;
  beforeRun?: (project: string, task: string, ai: string, account: string) => Promise<void>;
  onCompleted?: (input: { requestId: string; sessionId?: string; project: string; task: string; ai: string; account: string; usage: TurnUsage | null }) => Promise<void>;
  onChanged: (project: string, task: string) => void;
  isRunning: (project: string, task: string) => boolean;
  publish: (project: string, task: string, event: ChatEvent) => void;
}

/** Review never reads/writes conversation metadata or resumes a writing session. */
export class ReviewService {
  private readonly running = new Map<string, { run?: CliRun; stopped: boolean; done?: Promise<ReviewResult>; info: RunningInfo }>();
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
    const position = await this.deps.store.append(project, task, row);
    this.deps.publish(project, task, { event: 'row', data: { ...row, position } });
  }
  private file(project: string, task: string): string { return path.join(this.deps.ws.projectDir(project), '.ai', 'reviews', `${task}.json`); }
  private async cwd(project: string, task: string): Promise<string> {
    const record = await this.deps.tasks.get(project, task);
    return record.workspace === 'isolated' && record.workdir ? record.workdir : this.deps.worktree.bodyPath(project);
  }
  async history(project: string, task: string): Promise<ReviewHistory> {
    const fingerprint = await reviewFingerprint(await this.cwd(project, task));
    const history = await readJson<ReviewHistory>(this.file(project, task), { snapshots: [], requireApproval: false, stale: true });
    const latest = history.snapshots.at(-1);
    return { ...history, stale: !latest || latest.content !== fingerprint.content || latest.revision !== fingerprint.revision };
  }
  async setGate(project: string, task: string, required: boolean): Promise<ReviewHistory> {
    await this.deps.tasks.get(project, task);
    const file = this.file(project, task);
    await withFileLocks([file], async () => {
      const history = await readJson<ReviewHistory>(file, { snapshots: [], requireApproval: false, stale: true });
      history.requireApproval = required; await writeJson(file, history);
    });
    this.deps.onChanged(project, task); return this.history(project, task);
  }
  async updateFinding(project: string, task: string, snapshot: string, finding: string, state: ReviewFindingState, evidence: string): Promise<ReviewHistory> {
    await this.deps.tasks.get(project, task);
    if (!['open', 'resolved', 'dismissed'].includes(state) || !evidence.trim() || evidence.length > 10000 || this.isBusy(project, task)) throw new AppError('bad_request');
    const file = this.file(project, task);
    await withFileLocks([file], async () => {
      const history = await readJson<ReviewHistory>(file, { snapshots: [], requireApproval: false, stale: true });
      const item = history.snapshots.find(s => s.id === snapshot)?.findings.find(f => f.id === finding);
      if (!item) throw new AppError('not_found');
      item.state = state; item.transitions.push({ state, evidence, at: new Date().toISOString() });
      await writeJson(file, history);
    });
    this.deps.onChanged(project, task); return this.history(project, task);
  }
  async assertMergeAllowed(project: string, task: string): Promise<void> {
    const history = await this.history(project, task); const latest = history.snapshots.at(-1);
    if (history.requireApproval && (history.stale || !latest?.ok || !latest.structured
      || latest.findings.some(f => f.state === 'open' && (f.severity === 'major' || f.severity === 'critical'))
      || !latest.approved)) throw new AppError('conflict');
  }
  run(project: string, task: string, input: ReviewInput): Promise<ReviewResult> {
    const key = JSON.stringify([project, task]);
    if (this.closed) return Promise.reject(new AppError('unavailable'));
    if (this.deps.isRunning(project, task) || this.running.has(key) || this.running.size >= this.deps.limits.concurrentRuns) return Promise.reject(new AppError('conflict'));
    const provider = this.deps.providers[input.ai];
    if (!provider?.supportsReadonly || !provider.readonlyEnforcement) return Promise.reject(new AppError('bad_request', 'cli_unsupported'));
    if (!input.text.trim() || input.text.length > this.deps.limits.promptChars) return Promise.reject(new AppError('bad_request'));
    const request = randomUUID();
    const entry: { run?: CliRun; stopped: boolean; done?: Promise<ReviewResult>; info: RunningInfo } = { stopped: false,
      info: { kind: 'review', project, task, request, ai: input.ai, startedAt: new Date().toISOString(), ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) } };
    this.running.set(key, entry);
    this.deps.onChanged(project, task);
    entry.done = (async () => {
      const started = Date.now();
      let text = ''; let session: string | undefined; let usage: TurnUsage | undefined; let asks: Ask[] | undefined;
      let failure = false; let timer: NodeJS.Timeout | undefined; let appended = false;
      try {
        const cwd = await this.cwd(project, task);
        const fingerprint = await reviewFingerprint(cwd);
        const settings = await this.deps.settings.get();
        if (!await provider.available()) throw new AppError('bad_request', 'cli_unavailable');
        if (entry.stopped || this.closed) throw new AppError('conflict');
        const account = settings.activeAccounts[input.ai] ?? 'default';
        await this.deps.beforeRun?.(project, task, input.ai, account);
        const selection = { ...(input.model === undefined ? {} : { model: input.model }), ...(input.effort === undefined ? {} : { effort: input.effort }) };
        await this.append(project, task, { at: new Date().toISOString(), role: 'user', to: input.ai, text: input.text, ...selection, request });
        appended = true;
        if (entry.stopped || this.closed) throw new AppError('conflict');
        entry.run = provider.send({ prompt: `${REVIEW_PROTOCOL}\n\n${input.text}`, cwd, readonly: true,
          ...selection, accountId: settings.activeAccounts[input.ai] ?? 'default' }, event => {
          if (event.type === 'delta') {
            const remaining = Math.max(0, 2_000_000 - text.length);
            text += event.text.slice(0, remaining);
            if (event.text.length > remaining) { failure = true; entry.run?.stop(); }
          }
          else if (event.type === 'result') { text = event.text.slice(0, 2_000_000); failure ||= event.text.length > 2_000_000; }
          else if (event.type === 'session') session = event.id;
          else if (event.type === 'usage') usage = event.usage;
          else if (event.type === 'asks') asks = event.asks;
          else if (event.type === 'error') failure = true;
        });
        timer = setTimeout(() => { entry.stopped = true; entry.run?.stop(); }, this.deps.limits.runSeconds * 1000);
        const outcome = await entry.run.done;
        await this.deps.onCompleted?.({ requestId: request, ...(session ? { sessionId: session } : {}), project, task, ai: input.ai, account, usage: usage ?? null });
        failure ||= !outcome.ok;
        entry.stopped ||= outcome.stopped;
        await this.append(project, task, { at: new Date().toISOString(), role: 'assistant', ai: input.ai, text,
          ...selection, request, ms: Date.now() - started, ...(usage ? { usage } : {}),
          ...(failure ? { error: 'review_failed' } : {}), ...(entry.stopped ? { stopped: true } : {}), ...(asks ? { asks } : {}) });
        appended = false;
        const parsed = parseReviewOutput(text);
        const current = await reviewFingerprint(cwd);
        const ok = !failure && !entry.stopped;
        const snapshot: ReviewSnapshot = { id: request, request, ai: input.ai, at: new Date().toISOString(), ...fingerprint, text, ok,
          ...parsed, approved: ok && parsed.approved && !asks?.length && current.content === fingerprint.content && current.revision === fingerprint.revision };
        const file = this.file(project, task);
        await withFileLocks([file], async () => {
          const history = await readJson<ReviewHistory>(file, { snapshots: [], requireApproval: false, stale: true });
          history.snapshots.push(snapshot); await writeJson(file, history);
        });
        return { request, text, ai: input.ai, ...(session ? { session } : {}), ...(asks ? { asks } : {}), ok, approved: snapshot.approved, structured: parsed.structured, snapshot };
      } catch (error) {
        if (appended) await this.append(project, task, { at: new Date().toISOString(), role: 'assistant', ai: input.ai, text, request, ms: Date.now() - started, error: 'review_failed', ...(entry.stopped ? { stopped: true } : {}) });
        throw error;
      } finally {
        clearTimeout(timer); this.running.delete(key); this.deps.onChanged(project, task);
      }
    })();
    return entry.done;
  }
  /** Read-only reviews in progress, listed with chat runs so they can be seen and stopped from the running panel. */
  active(): RunningInfo[] { return [...this.running.values()].map(entry => ({ ...entry.info })); }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.running.values()) { entry.stopped = true; entry.run?.stop(); }
    await Promise.allSettled([...this.running.values()].map(entry => entry.done));
  }
}
