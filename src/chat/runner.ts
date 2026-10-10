// 每作業的送出／停止串行化；CLI 執行不持鎖，讓補充與取消可立即中止。
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { CliProvider, CliRun } from '../cli/provider.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { CompletionStore } from '../ledger/completion.ts';
import type { SettingsStore } from '../ledger/settings.ts';
import type { OpLog } from '../ledger/oplog.ts';
import type { WorktreeService } from '../git/worktree.ts';
import { resolveLaunch } from '../roles/roles.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';
import type {
  Ask, Busy, ChatEvent, ChatRow, QueueItem, Roles, RunningInfo,
  SendInput, SendResult, Task,
} from '../shared/types.ts';
import { buildHandoff, buildPreamble, buildPrompt } from './prompt.ts';
import { ChatStore, type ChatMeta } from './store.ts';
import { attachImages } from './attachments.ts';
import { parseAsk } from './ask.ts';

export interface RunnerDeps {
  ws: Workspace;
  store: ChatStore;
  projects: ProjectLedger;
  tasks: TaskLedger;
  completion: CompletionStore;
  worktree: WorktreeService;
  settings: SettingsStore;
  oplog: OpLog;
  roles: () => Promise<Roles>;
  providers: Record<string, CliProvider>;
  limits: {
    concurrentRuns: number;
    queueLength: number;
    handoffChars: number;
    imagesPerSend: number;
  };
  publish(project: string, task: string, event: ChatEvent): void;
  watching(project: string, task: string): boolean;
  onChanged(project?: string, task?: string): void;
}
interface Slot {
  busy: Busy | null;
  partial: string;
  run: CliRun | null;
  finished: Promise<void>;
  text: string;
}

export class ChatRunner extends EventEmitter {
  private readonly deps: RunnerDeps;
  private readonly slots = new Map<string, Slot>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly unreadTasks = new Map<string, { project: string; task: string }>();
  private readonly jobs = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(deps: RunnerDeps) {
    super();
    this.deps = deps;
  }

  private slot(p: string, t: string): Slot {
    const key = `${p}\0${t}`;
    let s = this.slots.get(key);
    if (!s) {
      s = { busy: null, partial: '', run: null, finished: Promise.resolve(), text: '' };
      this.slots.set(key, s);
    }
    return s;
  }

  private lock<T>(p: string, t: string, fn: () => Promise<T>): Promise<T> {
    const key = `${p}\0${t}`;
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(key, next);
    return next;
  }

  private publish(p: string, t: string, event: ChatEvent): void {
    this.deps.publish(p, t, event);
    this.emit('event', p, t, event);
  }

  running(): RunningInfo[] {
    const runs: RunningInfo[] = [];
    for (const [key, s] of this.slots) {
      if (s.busy) {
        const [project, task] = key.split('\0');
        runs.push({ ...s.busy, project: project!, task: task! });
      }
    }
    return runs;
  }

  isRunning(p: string, t: string): boolean {
    return this.slot(p, t).busy !== null;
  }

  unread(): { project: string; task: string }[] {
    return [...this.unreadTasks.values()];
  }

  markRead(p: string, t: string): void {
    if (this.unreadTasks.delete(`${p}\0${t}`)) this.deps.onChanged(p, t);
  }

  async whenIdle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    for (const s of this.slots.values()) {
      s.text = '';
      s.run?.stop();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          await Promise.allSettled([...this.locks.values()]);
          for (const s of this.slots.values()) {
            s.text = '';
            s.run?.stop();
          }
          await Promise.allSettled([...this.slots.values()].map(s => s.finished));
        })(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 4500); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async snapshot(p: string, t: string): Promise<{
    rows: ChatRow[]; busy: Busy | null; partial: string; queue: QueueItem[];
  }> {
    await this.deps.tasks.get(p, t);
    const s = this.slot(p, t);
    return {
      rows: await this.deps.store.readLog(p, t),
      busy: s.busy,
      partial: s.partial,
      queue: await this.deps.store.readQueue(p, t),
    };
  }

  send(input: SendInput): Promise<SendResult> {
    return this.lock(input.project, input.task, () => this.sendLocked(input));
  }

  private async sendLocked(input: SendInput): Promise<SendResult> {
    if (this.shuttingDown) throw new AppError('unavailable');
    const { project: p, task: t } = input;
    const s = this.slot(p, t);
    let chosen = input;
    if (input.fromQueue) {
      if (s.busy) throw new AppError('conflict');
      const q = await this.deps.store.readQueue(p, t);
      const item = q.find(x => x.id === input.fromQueue);
      if (!item) throw new AppError('not_found', 'queue_item_missing');
      chosen = {
        project: p, task: t, text: item.text, ai: item.ai, mode: 'queue',
        ...(item.model ? { model: item.model } : {}),
        ...(item.effort ? { effort: item.effort } : {}),
        ...(item.images ? { images: item.images } : {}),
      };
    }
    if (typeof chosen.text !== 'string' || (!chosen.text.trim() && !chosen.images?.length)) {
      throw new AppError('bad_request');
    }
    if (chosen.images && (!Array.isArray(chosen.images) || chosen.images.length > this.deps.limits.imagesPerSend)) {
      throw new AppError('bad_request');
    }
    if (s.busy && !chosen.mode) throw new AppError('conflict', 'mode_required');
    const task = await this.deps.tasks.get(p, t);
    const settings = await this.deps.settings.get();
    const pick = resolveLaunch(await this.deps.roles(), task, {
      ...(chosen.ai ? { cli: chosen.ai } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.effort ? { effort: chosen.effort } : {}),
    }, settings.initial);
    const provider = this.deps.providers[pick.cli];
    if (!provider) throw new AppError('bad_request', 'cli_unsupported');
    if (!await provider.available()) throw new AppError('bad_request', 'cli_unavailable');
    if (this.shuttingDown) throw new AppError('unavailable');
    const item: QueueItem = {
      id: randomUUID(), text: chosen.text, ai: pick.cli,
      model: pick.model, effort: pick.effort, at: new Date().toISOString(),
      ...(chosen.images ? { images: chosen.images } : {}),
    };
    if (s.busy && chosen.mode === 'queue') {
      const queue = await this.deps.store.updateQueue(p, t, q => {
        if (q.length >= this.deps.limits.queueLength) throw new AppError('unavailable', 'queue_full');
        return [...q, item];
      });
      this.publish(p, t, { event: 'queue', data: queue });
      await this.deps.oplog.record({ action: 'chatqueue', project: p, task: t });
      this.deps.onChanged(p, t);
      return { request: item.id, queued: true };
    }
    if (s.busy) {
      const previous = s.text.slice(0, 400);
      s.run?.stop();
      await s.finished;
      item.text = chosen.mode === 'redo'
        ? `（人取消了前一個指示「${previous}」。如果途中改了檔案，必要時先還原，然後只做這個新指示）\n${chosen.text}`
        : `（人送來補充說明。不要取消目前的指示「${previous}」，延續已做到的部分，並一起處理這個補充）\n${chosen.text}`;
    }
    if (this.running().length >= this.deps.limits.concurrentRuns) throw new AppError('unavailable', 'runs_limit');
    // 先佔槽，再做工作目錄與檔案 I/O，避免跨作業同時超過執行上限。
    s.busy = {
      request: item.id, ai: item.ai, model: pick.model, effort: pick.effort,
      startedAt: new Date().toISOString(),
      ...(chosen.answer ? { mode: 'answer' } : chosen.mode ? { mode: chosen.mode } : {}),
    };
    try {
      const cwd = await this.deps.worktree.prepare(p, t);
      const images = await attachImages(this.deps.ws, p, t, chosen.images ?? [], this.deps.limits.imagesPerSend);
      if (this.shuttingDown) throw new AppError('unavailable');
      if (task.state === '完成') await this.deps.completion.revoke(p, t);
      await this.deps.tasks.update(p, t, {
        state: '進行中', cli: pick.cli, model: pick.model, effort: pick.effort,
        ...(chosen.answer ? { question: '' } : {}),
      });
      if (input.fromQueue) {
        const q = await this.deps.store.updateQueue(p, t, q => q.filter(x => x.id !== input.fromQueue));
        this.publish(p, t, { event: 'queue', data: q });
      }
      const prior = await this.deps.store.readLog(p, t);
      const meta = await this.deps.store.readMeta(p, t);
      const resumeId = item.ai !== 'codex' || meta.models[item.ai] === item.model
        ? meta.sessions[item.ai] : undefined;
      const roles = await this.deps.roles();
      const project = await this.deps.projects.get(p);
      const preamble = resumeId
        ? `繼續作業 ${t}：${this.deps.ws.taskFile(p, t)}。工作目錄：${cwd}。先讀 ${path.join(this.deps.ws.projectDir(p), '.ai/rules.md')}；區切時更新作業檔，不要自己把 state 寫成 完成。\n請使用人類這次指示所使用的相同語言回覆。`
        : buildPreamble({
          project: project.name, projectDir: this.deps.ws.projectDir(p),
          taskId: t, taskTitle: task.title, taskFile: this.deps.ws.taskFile(p, t),
          cwd, role: task.role, job: roles.roles[task.role]?.job ?? '', cli: item.ai,
        });
      const handoff = buildHandoff(resumeId ? unseenRows(prior, meta, item.ai) : prior, this.deps.limits.handoffChars);
      const user: ChatRow = {
        at: item.at, role: 'user', text: item.text, to: item.ai,
        model: pick.model, effort: pick.effort, request: item.id,
        ...(s.busy.mode ? { mode: s.busy.mode } : {}),
        ...(images.length ? { images } : {}),
      };
      meta.running = {
        request: item.id, ai: item.ai, model: pick.model,
        effort: pick.effort, startedAt: s.busy.startedAt,
      };
      await this.deps.store.writeMeta(p, t, meta);
      await this.deps.store.append(p, t, user);
      this.publish(p, t, { event: 'row', data: user });
      this.publish(p, t, { event: 'busy', data: s.busy });
      s.text = item.text;
      s.partial = '';
      await this.deps.oplog.record({
        action: chosen.mode === 'redo' ? 'chatredo' : chosen.mode === 'amend' ? 'chatamend' : 'chat',
        project: p, task: t,
      });
      this.deps.onChanged(p, t);
      s.finished = this.execute(p, t, item, provider, meta, {
        prompt: buildPrompt({ preamble, handoff, text: item.text, images }), cwd,
        ...(resumeId ? { resumeId } : {}), model: pick.model, effort: pick.effort,
        fullAccess: settings.fullAccess[item.ai] ?? provider.dangerous,
        addDirs: [path.join(this.deps.ws.projectDir(p), '.ai')], images,
      });
      this.trackQueuedRun(p, t, s);
      return { request: item.id, queued: false };
    } catch (err) {
      s.busy = null;
      s.run = null;
      s.partial = '';
      this.deps.onChanged(p, t);
      throw err;
    }
  }

  private trackQueuedRun(p: string, t: string, s: Slot): void {
    const job = s.finished.then(async () => {
      await this.lock(p, t, async () => {
        if (s.busy || this.shuttingDown) return;
        const queue = await this.deps.store.readQueue(p, t);
        const first = queue[0];
        if (!first || first.error || s.text === '') return;
        try {
          await this.sendLocked({ project: p, task: t, text: first.text, fromQueue: first.id });
        } catch (err) {
          const q = await this.deps.store.updateQueue(p, t, q => q.map(x => x.id === first.id
            ? { ...x, error: err instanceof AppError ? err.code : 'internal' } : x));
          this.publish(p, t, { event: 'queue', data: q });
          this.deps.onChanged(p, t);
        }
      });
    }).catch(err => {
      log.error('對話收尾失敗', err, { project: p, task: t });
    }).finally(() => {
      this.jobs.delete(job);
    });
    this.jobs.add(job);
  }

  private async execute(
    p: string, t: string, item: QueueItem, provider: CliProvider,
    meta: ChatMeta, opts: Parameters<CliProvider['send']>[0],
  ): Promise<void> {
    const s = this.slot(p, t);
    const started = Date.now();
    let result: string | undefined;
    let sid = opts.resumeId;
    let error = '';
    const asks: Ask[] = [];
    let writes = Promise.resolve();
    const previousSeen = meta.seen[item.ai];
    const previousSession = meta.sessions[item.ai];
    const previousModel = meta.models[item.ai];
    try {
      if (this.shuttingDown) throw new AppError('unavailable');
      const run = provider.send(opts, ev => {
        if (ev.type === 'session') sid = ev.id;
        else if (ev.type === 'delta') {
          s.partial += ev.text;
          this.publish(p, t, { event: 'delta', data: { request: item.id, text: ev.text } });
        } else if (ev.type === 'result') result = ev.text;
        else if (ev.type === 'error') {
          error = 'cli_failed';
          log.warn('CLI 回覆失敗', { project: p, task: t });
        } else if (ev.type === 'asks') asks.push(...ev.asks);
        else if (ev.type === 'tool') {
          const row: ChatRow = {
            at: new Date().toISOString(), role: 'event', ai: item.ai,
            tool: true, text: ev.text, request: item.id,
          };
          writes = writes.then(async () => {
            await this.deps.store.append(p, t, row);
            this.publish(p, t, { event: 'row', data: row });
          });
        }
      });
      s.run = run;
      const outcome = await run.done;
      await writes;
      const parsed = parseAsk(result ?? s.partial);
      asks.push(...parsed.asks);
      if (!outcome.ok && !outcome.stopped) error = 'cli_failed';
      const row: ChatRow = {
        at: new Date().toISOString(), role: 'assistant', ai: item.ai,
        model: item.model ?? '', effort: item.effort ?? '', text: parsed.text,
        ms: Date.now() - started, request: item.id,
        ...(error ? { error } : {}), ...(outcome.stopped ? { stopped: true } : {}),
        ...(asks.length ? { asks } : {}),
      };
      await this.deps.store.append(p, t, row);
      this.publish(p, t, { event: 'row', data: row });
      delete meta.running;
      if (error && !outcome.stopped) {
        if (opts.resumeId) {
          delete meta.sessions[item.ai];
          delete meta.models[item.ai];
        }
      } else {
        if (sid) {
          meta.sessions[item.ai] = sid;
          meta.models[item.ai] = item.model ?? '';
        }
        meta.seen[item.ai] = item.id;
      }
      await this.deps.store.writeMeta(p, t, meta);
      if (asks.length && !outcome.stopped) {
        await this.deps.tasks.update(p, t, {
          state: '等待回覆', question: asks.map(x => x.question).join(' / ').slice(0, 300),
        });
      }
      if (outcome.stopped || error) s.text = '';
    } catch (err) {
      log.error('對話執行失敗', err, { project: p, task: t });
      s.text = '';
      const row: ChatRow = {
        at: new Date().toISOString(), role: 'assistant', ai: item.ai,
        text: s.partial, error: 'internal', ms: Date.now() - started, request: item.id,
      };
      delete meta.running;
      if (previousSeen === undefined) delete meta.seen[item.ai];
      else meta.seen[item.ai] = previousSeen;
      if (opts.resumeId || previousSession === undefined) delete meta.sessions[item.ai];
      else meta.sessions[item.ai] = previousSession;
      if (opts.resumeId || previousModel === undefined) delete meta.models[item.ai];
      else meta.models[item.ai] = previousModel;
      await this.deps.store.writeMeta(p, t, meta);
      await this.deps.store.append(p, t, row);
      this.publish(p, t, { event: 'row', data: row });
    } finally {
      s.busy = null;
      s.run = null;
      s.partial = '';
      if (!this.deps.watching(p, t)) this.unreadTasks.set(`${p}\0${t}`, { project: p, task: t });
      this.publish(p, t, { event: 'idle', data: { request: item.id } });
      this.deps.onChanged(p, t);
    }
  }

  stop(p: string, t: string): Promise<boolean> {
    return this.lock(p, t, async () => {
      await this.deps.tasks.get(p, t);
      const s = this.slot(p, t);
      const stopped = Boolean(s.busy);
      s.text = '';
      s.run?.stop();
      await s.finished;
      const q = await this.deps.store.updateQueue(p, t, () => []);
      this.publish(p, t, { event: 'queue', data: q });
      await this.deps.oplog.record({ action: 'chatstop', project: p, task: t });
      this.deps.onChanged(p, t);
      return stopped;
    });
  }

  unqueue(p: string, t: string, id: string): Promise<QueueItem[]> {
    return this.lock(p, t, async () => {
      await this.deps.tasks.get(p, t);
      const q = await this.deps.store.updateQueue(p, t, q => {
        if (!q.some(x => x.id === id)) throw new AppError('not_found', 'queue_item_missing');
        return q.filter(x => x.id !== id);
      });
      this.publish(p, t, { event: 'queue', data: q });
      this.deps.onChanged(p, t);
      return q;
    });
  }
}

export function unseenRows(rows: ChatRow[], meta: ChatMeta, ai: string): ChatRow[] {
  const mark = meta.seen[ai];
  if (!mark) return rows;
  const index = rows.findLastIndex(r => r.role === 'assistant' && r.request === mark);
  return index < 0 ? rows : rows.slice(index + 1);
}
