// 對話執行狀態機：每個作業同時只有一輪在跑；執行中送出的指示進隊列，本輪結束後自動出隊。
// 停止：終止子行程，已收部分存檔並標記 cancelled；隊列不清（人要清可逐筆移除）。
// 所有狀態變化都以 SSE 事件形式發出（'event', project, task, SseEvent）。

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { CliProvider, CliRun } from '../cli/provider.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { Workspace } from '../ledger/workspace.ts';
import { resolveLaunch, type Launch } from '../roles/roles.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';
import type { ChatRow, QueueItem, Roles, RunState, SseEvent, Task } from '../shared/types.ts';
import { buildHandoff, buildPreamble, buildPrompt } from './prompt.ts';
import type { ChatStore } from './store.ts';

export interface RunnerDeps {
  ws: Workspace;
  store: ChatStore;
  tasks: TaskLedger;
  roles: () => Promise<Roles>;
  providers: Record<string, CliProvider>;
  limits: { concurrentRuns: number; queueLength: number; handoffChars: number };
  /** 回傳本輪 CLI 的工作目錄（Phase 3 起為 worktree 副本）。 */
  prepareCwd: (project: string, task: string) => Promise<string>;
}

interface TaskRun {
  running: RunState | null;
  partial: string;
  run: CliRun | null;
}

export interface SendResult {
  request: string;
  queued: boolean;
}

export class ChatRunner extends EventEmitter {
  private readonly deps: RunnerDeps;
  private readonly state = new Map<string, TaskRun>();

  constructor(deps: RunnerDeps) {
    super();
    this.deps = deps;
  }

  private key(project: string, task: string): string {
    return `${project}\u0000${task}`;
  }

  private slot(project: string, task: string): TaskRun {
    const k = this.key(project, task);
    let s = this.state.get(k);
    if (!s) {
      s = { running: null, partial: '', run: null };
      this.state.set(k, s);
    }
    return s;
  }

  private emitEvent(project: string, task: string, ev: SseEvent): void {
    this.emit('event', project, task, ev);
  }

  private get activeRuns(): number {
    let n = 0;
    for (const s of this.state.values()) if (s.running) n++;
    return n;
  }

  isRunning(project: string, task: string): boolean {
    return this.slot(project, task).running !== null;
  }

  async snapshot(project: string, task: string): Promise<{ running: RunState | null; partial: string; queue: QueueItem[] }> {
    const s = this.slot(project, task);
    return { running: s.running, partial: s.partial, queue: await this.deps.store.readQueue(project, task) };
  }

  /** 送出指示：閒置就立刻執行，執行中則入隊。回 request 編號。 */
  async send(project: string, task: string, text: string, override: Partial<Launch>): Promise<SendResult> {
    const taskDoc = await this.deps.tasks.get(project, task);
    const launch = resolveLaunch(await this.deps.roles(), taskDoc, override);
    const provider = this.deps.providers[launch.cli];
    if (!provider) throw new AppError('bad_request', `不支援的 CLI：${launch.cli}`);
    if (!(await provider.available())) throw new AppError('bad_request', `${launch.cli} 未安裝或不可用`);
    const item: QueueItem = {
      request: randomUUID(),
      text,
      cli: launch.cli,
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.effort ? { effort: launch.effort } : {}),
      at: new Date().toISOString(),
    };
    const s = this.slot(project, task);
    if (s.running) {
      const queue = await this.deps.store.readQueue(project, task);
      if (queue.length >= this.deps.limits.queueLength) throw new AppError('unavailable', '排隊指示已達上限');
      queue.push(item);
      await this.deps.store.writeQueue(project, task, queue);
      this.emitEvent(project, task, { event: 'queue', data: queue });
      return { request: item.request, queued: true };
    }
    if (this.activeRuns >= this.deps.limits.concurrentRuns) throw new AppError('unavailable', '同時執行中的對話已達上限');
    this.launch(project, task, item, taskDoc, provider);
    return { request: item.request, queued: false };
  }

  /** 同步佔住執行槽再非同步跑，避免兩個 send 同時看到閒置。 */
  private launch(project: string, task: string, item: QueueItem, taskDoc: Task, provider: CliProvider): void {
    const s = this.slot(project, task);
    s.running = { request: item.request, cli: item.cli, ...(item.model ? { model: item.model } : {}), startedAt: new Date().toISOString() };
    s.partial = '';
    void this.start(project, task, item, taskDoc, provider).catch((err) => {
      log.error('對話執行例外', err, { project, task, request: item.request });
      s.running = null;
      s.run = null;
      this.emitEvent(project, task, { event: 'error', data: { request: item.request, code: 'internal' } });
      this.emitEvent(project, task, { event: 'done', data: { request: item.request } });
    });
  }

  /** 停止目前執行；回 false 代表沒有在跑。 */
  stop(project: string, task: string): boolean {
    const s = this.slot(project, task);
    if (!s.run) return false;
    s.run.stop();
    return true;
  }

  async removeQueued(project: string, task: string, request: string): Promise<QueueItem[]> {
    const queue = await this.deps.store.readQueue(project, task);
    const next = queue.filter((q) => q.request !== request);
    if (next.length === queue.length) throw new AppError('not_found', '隊列中沒有這筆指示');
    await this.deps.store.writeQueue(project, task, next);
    this.emitEvent(project, task, { event: 'queue', data: next });
    return next;
  }

  private async start(project: string, task: string, item: QueueItem, taskDoc: Task, provider: CliProvider): Promise<void> {
    const { store, ws, tasks, limits } = this.deps;
    const s = this.slot(project, task);
    const prior = await store.readLog(project, task);
    const meta = await store.readMeta(project, task);
    const resumeId = meta.sessions[item.cli];
    const unseen = prior.slice(meta.seen[item.cli] ?? 0);
    const handoff = buildHandoff(unseen, limits.handoffChars);

    const userRow: ChatRow = { at: item.at, role: 'user', text: item.text, cli: item.cli, ...(item.model ? { model: item.model } : {}), request: item.request };
    await store.append(project, task, userRow);
    this.emitEvent(project, task, { event: 'log', data: userRow });

    let cwd: string;
    try {
      cwd = await this.deps.prepareCwd(project, task);
    } catch (err) {
      await this.finishWithError(project, task, item, 'prepare_failed', err);
      return;
    }
    const roles = await this.deps.roles();
    const preamble = resumeId
      ? undefined
      : buildPreamble({
          project,
          projectDir: ws.projectDir(project),
          taskId: task,
          taskTitle: taskDoc.title,
          taskFile: ws.taskFile(project, task),
          cwd,
          role: taskDoc.role,
          job: roles.roles[taskDoc.role]?.job ?? '',
          cli: item.cli,
        });
    const prompt = buildPrompt({ ...(preamble ? { preamble } : {}), ...(handoff ? { handoff } : {}), text: item.text });

    if (taskDoc.state === '未開始') {
      const updated = await tasks.update(project, task, { state: '進行中' });
      this.emitEvent(project, task, { event: 'task', data: updated });
    }

    s.partial = '';
    let sessionId = resumeId;
    let result: string | undefined;
    let errorReason: string | undefined;
    const run = provider.send(
      {
        prompt,
        cwd,
        ...(resumeId ? { resumeId } : {}),
        ...(item.model ? { model: item.model } : {}),
        ...(item.effort ? { effort: item.effort } : {}),
        addDirs: [ws.projectDir(project)],
      },
      (ev) => {
        switch (ev.type) {
          case 'session':
            sessionId = ev.id;
            break;
          case 'delta':
            s.partial += ev.text;
            this.emitEvent(project, task, { event: 'delta', data: { request: item.request, text: ev.text } });
            break;
          case 'result':
            result = ev.text;
            break;
          case 'error':
            errorReason = ev.reason;
            break;
        }
      },
    );
    s.run = run;
    log.info('對話開始', { project, task, cli: item.cli, request: item.request, resume: Boolean(resumeId), handoff: handoff.length });

    const outcome = await run.done;
    const text = result ?? s.partial;
    const rows: ChatRow[] = [];
    if (outcome.stopped) {
      rows.push({ at: new Date().toISOString(), role: 'assistant', text, cli: item.cli, request: item.request, cancelled: true });
    } else if (outcome.ok && errorReason === undefined) {
      rows.push({ at: new Date().toISOString(), role: 'assistant', text, cli: item.cli, request: item.request });
    } else {
      if (text) rows.push({ at: new Date().toISOString(), role: 'assistant', text, cli: item.cli, request: item.request, interrupted: true });
      rows.push({ at: new Date().toISOString(), role: 'error', text: 'CLI 執行失敗', cli: item.cli, request: item.request });
      log.warn('對話失敗', { project, task, cli: item.cli, request: item.request, reason: (errorReason ?? outcome.reason ?? '').slice(0, 500) });
    }
    for (const row of rows) {
      await store.append(project, task, row);
      this.emitEvent(project, task, { event: 'log', data: row });
    }
    if (sessionId) meta.sessions[item.cli] = sessionId;
    meta.seen[item.cli] = prior.length + 1 + rows.length;
    await store.writeMeta(project, task, meta);

    s.running = null;
    s.run = null;
    s.partial = '';
    if (!outcome.ok && !outcome.stopped) this.emitEvent(project, task, { event: 'error', data: { request: item.request, code: 'cli_failed' } });
    this.emitEvent(project, task, { event: 'done', data: { request: item.request } });
    log.info('對話結束', { project, task, request: item.request, ok: outcome.ok, stopped: outcome.stopped });

    await this.drain(project, task);
  }

  private async finishWithError(project: string, task: string, item: QueueItem, code: string, err: unknown): Promise<void> {
    log.error('對話無法開始', err, { project, task, request: item.request });
    const row: ChatRow = { at: new Date().toISOString(), role: 'error', text: '無法開始執行', cli: item.cli, request: item.request };
    await this.deps.store.append(project, task, row);
    this.emitEvent(project, task, { event: 'log', data: row });
    this.emitEvent(project, task, { event: 'error', data: { request: item.request, code } });
    this.emitEvent(project, task, { event: 'done', data: { request: item.request } });
    await this.drain(project, task);
  }

  /** 本輪結束後：有排隊就出隊執行。 */
  private async drain(project: string, task: string): Promise<void> {
    const queue = await this.deps.store.readQueue(project, task);
    const next = queue.shift();
    if (!next) return;
    await this.deps.store.writeQueue(project, task, queue);
    this.emitEvent(project, task, { event: 'queue', data: queue });
    const provider = this.deps.providers[next.cli];
    let taskDoc: Task;
    try {
      taskDoc = await this.deps.tasks.get(project, task);
    } catch (err) {
      await this.finishWithError(project, task, next, 'task_missing', err);
      return;
    }
    if (!provider) {
      await this.finishWithError(project, task, next, 'cli_missing', new Error(`provider ${next.cli} 不存在`));
      return;
    }
    // 不 await：讓呼叫端（上一輪）先收尾
    this.launch(project, task, next, taskDoc, provider);
  }
}
