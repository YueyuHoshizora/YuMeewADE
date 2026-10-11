// 每作業的送出／停止串行化；CLI 執行不持鎖，讓補充與取消可立即中止。
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { CliEvent, CliProvider, CliRun } from '../cli/provider.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { CompletionStore } from '../ledger/completion.ts';
import type { SettingsStore } from '../ledger/settings.ts';
import type { OpLog } from '../ledger/oplog.ts';
import type { WorktreeService } from '../git/worktree.ts';
import { resolveAvailableLaunch } from '../roles/roles.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';
import type {
  Ask, Busy, ChatEvent, ChatHistory, ChatRow, QueueItem, Roles, RunningInfo,
  SendInput, SendResult, Task, TurnUsage, VerifyResult, ContextPreview,
} from '../shared/types.ts';
import { HISTORY_PAGE } from '../shared/types.ts';
import { buildHandoff, buildPreamble, buildPrompt, inspectHandoff } from './prompt.ts';
import { buildTaskContext } from './context.ts';
import { ChatStore, type ChatMeta } from './store.ts';
import { attachImages } from './attachments.ts';
import { parseAsk } from './ask.ts';
import { slashName } from '../cli/commands.ts';
import { pathExists } from '../shared/fsx.ts';

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
    runSeconds: number;
  };
  publish(project: string, task: string, event: ChatEvent): void;
  watching(project: string, task: string): boolean;
  /** 在作業副本跑專案的驗證指令；省略＝不做自動驗證。 */
  verify?: (project: string, task: string) => Promise<VerifyResult>;
  onChanged(project?: string, task?: string): void;
  beforeSend?: (project: string, task: string, workflow: boolean) => Promise<void>;
  /** CLI 回報的帳號額度／輸出 token（帳號層級，不寫進對話）。 */
  onUsage(ai: string, ev: Extract<CliEvent, { type: 'quota' | 'tokens' }>, accountId: string): void;
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
  /** 目前這一串自動修正已用掉的次數；人下新指示就歸零。 */
  private readonly autoFixes = new Map<string, number>();
  private readonly unreadTasks = new Map<string, { project: string; task: string }>();
  private readonly jobs = new Map<Promise<void>, string>();
  private readonly stopVersions = new Map<string, number>();
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
    const settled = next.finally(async () => {
      if (this.locks.get(key) !== settled) return;
      try {
        const queue = await this.deps.store.readQueue(p, t);
        if (this.locks.get(key) !== settled) return;
        this.locks.delete(key);
        const slot = this.slots.get(key);
        if (slot && !slot.busy && !queue.length) this.slots.delete(key);
      } catch (err) {
        if (this.locks.get(key) === settled) this.locks.delete(key);
        log.error('對話收尾失敗', err, { project: p, task: t });
      }
    });
    this.locks.set(key, settled);
    return settled;
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
    const key = `${p}\0${t}`;
    return this.slots.get(key)?.busy != null || this.locks.has(key);
  }

  isBusy(project?: string, task?: string): boolean {
    if (project === undefined) {
      if (this.jobs.size || this.locks.size) return true;
      for (const slot of this.slots.values()) if (slot.busy) return true;
      return false;
    }
    const selected = task === undefined ? `${project}\0` : `${project}\0${task}`;
    for (const key of this.locks.keys()) if (task === undefined ? key.startsWith(selected) : key === selected) return true;
    for (const key of this.jobs.values()) if (task === undefined ? key.startsWith(selected) : key === selected) return true;
    for (const [key, slot] of this.slots) if (slot.busy && (task === undefined ? key.startsWith(selected) : key === selected)) return true;
    return false;
  }

  unread(): { project: string; task: string }[] {
    return [...this.unreadTasks.values()];
  }

  markRead(p: string, t: string): void {
    if (this.unreadTasks.delete(`${p}\0${t}`)) this.deps.onChanged(p, t);
  }

  async whenIdle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs.keys()]);
  }

  async whenTaskIdle(p: string, t: string): Promise<void> {
    const key = `${p}\0${t}`;
    for (;;) {
      const jobs = [...this.jobs].filter(([, task]) => task === key).map(([job]) => job);
      if (!jobs.length) return;
      await Promise.all(jobs);
    }
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
    rows: ChatRow[]; start: number; busy: Busy | null; partial: string; queue: QueueItem[];
  }> {
    await this.deps.tasks.get(p, t);
    const s = this.slots.get(`${p}\0${t}`);
    const rows = await this.deps.store.readLog(p, t);
    const start = Math.max(0, rows.length - HISTORY_PAGE);
    return {
      rows: rows.slice(start),
      start,
      busy: s?.busy ?? null,
      partial: s?.partial ?? '',
      queue: await this.deps.store.readQueue(p, t),
    };
  }

  async history(p: string, t: string, before: number): Promise<ChatHistory> {
    if (!Number.isSafeInteger(before) || before < 0) {
      throw new AppError('bad_request', 'field_type', { field: 'before' });
    }
    await this.deps.tasks.get(p, t);
    const rows = await this.deps.store.readLog(p, t);
    const end = Math.min(before, rows.length);
    const start = Math.max(0, end - HISTORY_PAGE);
    return { rows: rows.slice(start, end), start };
  }

  async outcome(p: string, t: string, request: string): Promise<Extract<ChatRow, { role: 'assistant' }> | undefined> {
    await this.deps.tasks.get(p, t);
    return (await this.deps.store.readLog(p, t)).findLast(
      (row): row is Extract<ChatRow, { role: 'assistant' }> => row.role === 'assistant' && row.request === request,
    );
  }

  async commands(p: string, t: string | undefined, ai: string) {
    if (ai !== 'claude' && ai !== 'codex' && ai !== 'grok' && ai !== 'gemini') throw new AppError('bad_request', 'cli_unsupported');
    const task = t === undefined ? undefined : await this.deps.tasks.get(p, t);
    const cwd = task && task.workspace !== 'direct' && task.workdir && await pathExists(task.workdir)
      ? task.workdir : await this.deps.worktree.bodyPath(p);
    const provider = this.deps.providers[ai];
    // Chats always run on the App's default slot; switching an account copies its credentials there.
    if (!provider?.commands || !await provider.available()) return [];
    return provider.commands(cwd);
  }

  async contextPreview(p: string, t: string, ai: string, model: string): Promise<ContextPreview> {
    const task = await this.deps.tasks.get(p, t);
    const settings = await this.deps.settings.get();
    const pick = await resolveAvailableLaunch(await this.deps.roles(), task, { cli: ai, model }, settings.initial, async cli => {
      const provider = this.deps.providers[cli];
      if (!provider) throw new AppError('bad_request', 'cli_unsupported', { field: cli });
      return provider.available();
    });
    const prior = await this.deps.store.readLog(p, t);
    const meta = await this.deps.store.readMeta(p, t);
    const sameAccount = (meta.accounts?.[pick.cli] ?? 'default') === (settings.activeAccounts[pick.cli] ?? 'default');
    const resume = sameAccount && (pick.cli !== 'codex' || meta.models[pick.cli] === pick.model) ? meta.sessions[pick.cli] : undefined;
    const selected = resume ? unseenRows(prior, meta, pick.cli) : prior;
    const cwd = task.workspace !== 'direct' && task.workdir && await pathExists(task.workdir) ? task.workdir : await this.deps.worktree.bodyPath(p);
    return {
      handoff: inspectHandoff(selected, this.deps.limits.handoffChars, prior.length - selected.length),
      context: await buildTaskContext(this.deps.ws, p, t, cwd, this.deps.limits.handoffChars),
    };
  }

  send(input: SendInput, options: { workflow?: boolean } = {}): Promise<SendResult> {
    const version = this.stopVersions.get(`${input.project}\0${input.task}`) ?? 0;
    return this.lock(input.project, input.task, () => this.sendLocked(input, false, options.workflow === true, version));
  }

  private async sendLocked(input: SendInput, auto = false, workflow = false, version = this.stopVersions.get(`${input.project}\0${input.task}`) ?? 0): Promise<SendResult> {
    if (this.shuttingDown) throw new AppError('unavailable');
    const { project: p, task: t } = input;
    const cancelled = () => version !== (this.stopVersions.get(`${p}\0${t}`) ?? 0);
    const assertActive = () => { if (cancelled()) throw new AppError('conflict', 'chat_stopped'); };
    await this.deps.beforeSend?.(p, t, auto || workflow);
    assertActive();
    if (!auto) this.autoFixes.delete(`${p}\0${t}`);
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
    const pick = await resolveAvailableLaunch(await this.deps.roles(), task, {
      ...(chosen.ai ? { cli: chosen.ai } : {}),
      ...(chosen.model !== undefined ? { model: chosen.model } : {}),
      ...(chosen.effort !== undefined ? { effort: chosen.effort } : {}),
    }, settings.initial, async cli => {
      const provider = this.deps.providers[cli];
      if (!provider) throw new AppError('bad_request', 'cli_unsupported', { field: cli });
      return provider.available();
    });
    const provider = this.deps.providers[pick.cli];
    if (!provider) throw new AppError('bad_request', 'cli_unsupported');
    const accountId = settings.activeAccounts[pick.cli] ?? 'default';
    if (!await provider.available()) throw new AppError('bad_request', 'cli_unavailable');
    if (this.shuttingDown) throw new AppError('unavailable');
    // Validate before queuing or interrupting a running turn; never bury control commands in prose.
    const name = slashName(chosen.text);
    const commandCwd = name
      ? task.workspace !== 'direct' && task.workdir && await pathExists(task.workdir)
        ? task.workdir : await this.deps.worktree.bodyPath(p)
      : '';
    let command: { text: string; native: boolean; standalone?: boolean } | undefined;
    if (name) {
      if (!provider.resolveCommand || chosen.answer || (s.busy && chosen.mode !== 'queue')) {
        throw new AppError('bad_request', 'slash_unsupported');
      }
      command = await provider.resolveCommand(chosen.text, commandCwd);
    }
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
    assertActive();
    // 先佔槽，再做工作目錄與檔案 I/O，避免跨作業同時超過執行上限。
    s.busy = {
      request: item.id, ai: item.ai, model: pick.model, effort: pick.effort,
      startedAt: new Date().toISOString(),
      ...(chosen.answer ? { mode: 'answer' } : chosen.mode ? { mode: chosen.mode } : {}),
    };
    try {
      const cwd = await this.deps.worktree.prepare(p, t);
      assertActive();
      if (command && cwd !== commandCwd) command = await provider.resolveCommand!(chosen.text, cwd);
      const checkpoint = await this.deps.worktree.checkpoint(p, t);
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
      const sameAccount = (meta.accounts?.[item.ai] ?? 'default') === accountId;
      const resumeId = sameAccount && (item.ai !== 'codex' || meta.models[item.ai] === item.model)
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
      const selectedHistory = resumeId ? unseenRows(prior, meta, item.ai) : prior;
      const handoff = buildHandoff(selectedHistory, this.deps.limits.handoffChars, prior.length - selectedHistory.length);
      const taskContext = await buildTaskContext(this.deps.ws, p, t, cwd, this.deps.limits.handoffChars);
      assertActive();
      const user: ChatRow = {
        at: item.at, role: 'user', text: item.text, to: item.ai,
        model: pick.model, effort: pick.effort, request: item.id,
        ...(s.busy.mode ? { mode: s.busy.mode } : {}),
        ...(images.length ? { images } : {}),
        ...(checkpoint ? { checkpoint } : {}),
      };
      meta.running = {
        request: item.id, ai: item.ai, model: pick.model,
        effort: pick.effort, startedAt: s.busy.startedAt,
      };
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
      await this.deps.store.writeMeta(p, t, meta);
      s.finished = this.execute(p, t, item, provider, meta, {
        prompt: buildPrompt({ preamble, handoff, context: taskContext.text, text: command ? (command.native ? '' : command.text) : item.text, images }), cwd,
        ...(command?.native ? { slashCommand: command.text } : {}),
        ...(command?.standalone ? { standalone: true } : resumeId ? { resumeId } : {}),
        model: pick.model, effort: pick.effort,
        fullAccess: settings.fullAccess[item.ai] ?? provider.dangerous,
        accountId,
        addDirs: [path.join(this.deps.ws.projectDir(p), '.ai')], images,
      }, checkpoint, cancelled);
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
      const sent = await this.lock(p, t, async () => {
        if (s.busy || this.shuttingDown) return false;
        const queue = await this.deps.store.readQueue(p, t);
        const first = queue[0];
        if (!first || first.error || s.text === '') return false;
        try {
          await this.sendLocked({ project: p, task: t, text: first.text, fromQueue: first.id });
        } catch (err) {
          const q = await this.deps.store.updateQueue(p, t, q => q.map(x => x.id === first.id
            ? { ...x, error: err instanceof AppError ? err.code : 'internal' } : x));
          this.publish(p, t, { event: 'queue', data: q });
          this.deps.onChanged(p, t);
        }
        return true;
      });
      // 只有人下的指令正常做完、隊列已空時才驗證；失敗、被停止、等人回答都不驗證。
      if (!sent && s.text !== '') await this.autoFix(p, t);
    }).catch(err => {
      log.error('對話收尾失敗', err, { project: p, task: t });
    }).finally(() => {
      this.jobs.delete(job);
    });
    this.jobs.set(job, `${p}\0${t}`);
  }

  /** 專案開了 autoFix 時：驗證失敗就把輸出交回同一個 AI，直到通過或用完次數。 */
  private async autoFix(p: string, t: string): Promise<void> {
    const verify = this.deps.verify;
    const key = `${p}\0${t}`;
    const version = this.stopVersions.get(key) ?? 0;
    if (!verify || this.shuttingDown) return;
    const project = await this.deps.projects.get(p);
    const task = await this.deps.tasks.get(p, t);
    if (!project.verify.trim() || project.autoFix < 1 || task.state === '等待回覆') { this.autoFixes.delete(key); return; }
    const result = await verify(p, t).catch(err => { log.warn('自動驗證失敗', { project: p, task: t, err: String(err) }); return null; });
    if (version !== (this.stopVersions.get(key) ?? 0)) return;
    const used = this.autoFixes.get(key) ?? 0;
    if (!result || result.ok) { this.autoFixes.delete(key); return; }
    if (used >= project.autoFix) {
      // 用完次數仍失敗：交還給人，讓作業顯示成「等你回覆」並觸發通知。
      this.autoFixes.delete(key);
      await this.lock(p, t, async () => {
        if (this.slot(p, t).busy || this.shuttingDown || version !== (this.stopVersions.get(key) ?? 0)) return;
        await this.deps.tasks.update(p, t, { state: '等待回覆', question: `驗證在 ${used} 次自動修正後仍失敗，請接手` });
        this.deps.onChanged(p, t);
      });
      return;
    }
    const output = result.output.length > 8000 ? result.output.slice(-8000) : result.output;
    const text = `（自動驗證：驗證指令 ${project.verify.trim()} ${result.timedOut ? '逾時' : `失敗，結束碼 ${result.exitCode ?? '無'}`}，這是第 ${used + 1}/${project.autoFix} 次自動修正）\n輸出尾段如下。請找出原因並修正，修正後自行再跑一次驗證確認。\n\n\`\`\`\n${output}\n\`\`\``;
    await this.lock(p, t, async () => {
      if (this.slot(p, t).busy || this.shuttingDown || (await this.deps.store.readQueue(p, t)).length || version !== (this.stopVersions.get(key) ?? 0)) return;
      this.autoFixes.set(key, used + 1);
      try { await this.sendLocked({ project: p, task: t, text }, true, false, version); }
      catch (err) { this.autoFixes.delete(key); log.warn('自動修正送出失敗', { project: p, task: t, err: String(err) }); }
    });
  }

  private async execute(
    p: string, t: string, item: QueueItem, provider: CliProvider,
    meta: ChatMeta, opts: Parameters<CliProvider['send']>[0], startCheckpoint?: string, cancelled: () => boolean = () => false,
  ): Promise<void> {
    const s = this.slot(p, t);
    const started = Date.now();
    let result: string | undefined;
    let sid = opts.resumeId;
    let error = '';
    let usage: TurnUsage | undefined;
    let persisted = false;
    const asks: Ask[] = [];
    let writes = Promise.resolve();
    let writeFailure: { error: unknown } | undefined;
    const previousSeen = meta.seen[item.ai];
    const previousSession = meta.sessions[item.ai];
    const previousModel = meta.models[item.ai];
    const previousAccount = meta.accounts?.[item.ai];
    try {
      if (this.shuttingDown) throw new AppError('unavailable');
      if (cancelled()) throw new AppError('conflict', 'chat_stopped');
      const run = provider.send(opts, ev => {
        if (ev.type === 'session') sid = ev.id;
        else if (ev.type === 'delta') {
          s.partial += ev.text;
          this.publish(p, t, { event: 'delta', data: { request: item.id, text: ev.text } });
        } else if (ev.type === 'result') result = ev.text;
        else if (ev.type === 'usage') usage = ev.usage;
        else if (ev.type === 'error') {
          error = 'cli_failed';
          log.warn('CLI 回覆失敗', { project: p, task: t });
        } else if (ev.type === 'asks') asks.push(...ev.asks);
        else if (ev.type === 'quota' || ev.type === 'tokens') this.deps.onUsage(item.ai, ev, opts.accountId ?? 'default');
        else if (ev.type === 'tool') {
          const row: ChatRow = {
            at: new Date().toISOString(), role: 'event', ai: item.ai,
            tool: true, text: ev.text, request: item.id,
          };
          writes = writes.then(async () => {
            if (writeFailure) return;
            await this.deps.store.append(p, t, row);
            this.publish(p, t, { event: 'row', data: row });
          }).catch(err => { writeFailure ??= { error: err }; });
        }
      });
      s.run = run;
      let timedOut = false;
      const limit = setTimeout(() => {
        timedOut = true;
        log.warn('執行超過時間上限，已停止', { project: p, task: t });
        run.stop();
      }, this.deps.limits.runSeconds * 1000);
      const outcome = await run.done.finally(() => clearTimeout(limit));
      await writes;
      if (writeFailure) throw writeFailure.error;
      const parsed = parseAsk(result ?? s.partial);
      asks.push(...parsed.asks);
      if (!outcome.ok && !outcome.stopped) error = 'cli_failed';
      if (timedOut) error = 'timeout';
      const turn = startCheckpoint
        ? await this.deps.worktree.finishTurn(p, t, startCheckpoint).catch(err => { log.warn('回合結束檢查點失敗', { project: p, task: t, err: String(err) }); return undefined; })
        : undefined;
      const row: ChatRow = {
        at: new Date().toISOString(), role: 'assistant', ai: item.ai,
        model: item.model ?? '', effort: item.effort ?? '', text: parsed.text,
        ms: Date.now() - started, request: item.id,
        ...(error ? { error } : {}), ...(outcome.stopped ? { stopped: true } : {}),
        ...(asks.length ? { asks } : {}),
        ...(usage ? { usage } : {}),
        ...(turn ? { after: turn.after, ...(turn.changes ? { changes: turn.changes } : {}) } : {}),
      };
      await this.deps.store.append(p, t, row);
      persisted = true;
      this.publish(p, t, { event: 'row', data: row });
      delete meta.running;
      if (error && !outcome.stopped) {
        if (opts.resumeId) {
          delete meta.sessions[item.ai];
          delete meta.models[item.ai];
        }
      } else if (!opts.standalone) {
        if ((meta.accounts?.[item.ai] ?? 'default') !== (opts.accountId ?? 'default')) {
          delete meta.sessions[item.ai];
          delete meta.models[item.ai];
          delete meta.seen[item.ai];
        }
        meta.accounts = { ...meta.accounts, [item.ai]: opts.accountId ?? 'default' };
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
        text: s.partial, ...(cancelled() ? { stopped: true } : { error: 'internal' }), ms: Date.now() - started, request: item.id,
        model: item.model ?? '', effort: item.effort ?? '',
        ...(usage ? { usage } : {}),
      };
      delete meta.running;
      if (previousSeen === undefined) delete meta.seen[item.ai];
      else meta.seen[item.ai] = previousSeen;
      if (opts.resumeId || previousSession === undefined) delete meta.sessions[item.ai];
      else meta.sessions[item.ai] = previousSession;
      if (opts.resumeId || previousModel === undefined) delete meta.models[item.ai];
      else meta.models[item.ai] = previousModel;
      if (previousAccount === undefined) { if (meta.accounts) delete meta.accounts[item.ai]; }
      else meta.accounts = { ...meta.accounts, [item.ai]: previousAccount };
      try { await this.deps.store.writeMeta(p, t, meta); }
      catch (cleanupError) { log.error('對話收尾失敗', cleanupError, { project: p, task: t }); }
      if (!persisted) {
        try { await this.deps.store.append(p, t, row); }
        catch (appendError) { log.error('對話收尾失敗', appendError, { project: p, task: t }); }
        this.publish(p, t, { event: 'row', data: row });
      }
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
    const key = `${p}\0${t}`;
    this.stopVersions.set(key, (this.stopVersions.get(key) ?? 0) + 1);
    const preparing = this.isRunning(p, t);
    const current = this.slots.get(key);
    if (current) { current.text = ''; current.run?.stop(); }
    return this.lock(p, t, async () => {
      await this.deps.tasks.get(p, t);
      const s = this.slot(p, t);
      const stopped = preparing || Boolean(s.busy);
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

  /** 從某則指示開始之前分支出新作業：副本長自該輪的檢查點，並帶走之前的對話當背景。 */
  fork(p: string, t: string, request: string): Promise<Task> {
    return this.lock(p, t, async () => {
      const source = await this.deps.tasks.get(p, t);
      if (this.slot(p, t).busy) throw new AppError('conflict', 'fork_while_running');
      const rows = await this.deps.store.readLog(p, t);
      const at = rows.findIndex(r => r.role === 'user' && r.request === request);
      const point = rows[at];
      if (point?.role !== 'user' || !point.checkpoint) throw new AppError('not_found', 'checkpoint_missing');
      const created = await this.deps.tasks.create(p, {
        title: `${source.title}（分支）`, kind: 'derived', derivedFrom: t, workspace: 'isolated',
        phase: source.phase, role: source.role, cli: source.cli, model: source.model, effort: source.effort,
      });
      try {
        await this.deps.worktree.prepareFrom(p, created.id, point.checkpoint);
        for (const row of rows.slice(0, at)) {
          if (row.role === 'user') {
            const { images: _images, ...plain } = row; // 附件檔屬於原作業，分支作業看不到
            await this.deps.store.append(p, created.id, plain);
          } else await this.deps.store.append(p, created.id, row);
        }
        await this.deps.store.append(p, created.id, {
          at: new Date().toISOString(), role: 'event',
          text: `從作業「${source.title}」的指示「${point.text.slice(0, 120)}」之前分支出來；工作副本是當時的狀態，之後的檔案變更不在這裡。`,
        });
      } catch (err) {
        await this.deps.tasks.archive(p, created.id).catch(() => undefined);
        throw err;
      }
      await this.deps.oplog.record({ action: 'task.fork', project: p, task: created.id });
      this.deps.onChanged(p, created.id);
      return this.deps.tasks.get(p, created.id);
    });
  }

  /** 單輪的變更：該輪使用者訊息的輪前檢查點 → 該輪回覆結束時的檢查點。 */
  async turnDiff(p: string, t: string, request: string): Promise<{ diff: string; truncated: boolean }> {
    await this.deps.tasks.get(p, t);
    const rows = await this.deps.store.readLog(p, t);
    const start = rows.find(r => r.role === 'user' && r.request === request);
    const end = rows.find(r => r.role === 'assistant' && r.request === request);
    if (start?.role !== 'user' || end?.role !== 'assistant' || !start.checkpoint || !end.after) throw new AppError('not_found', 'checkpoint_missing');
    return this.deps.worktree.rangeDiff(p, t, start.checkpoint, end.after);
  }

  /** 把工作副本還原到某則指示開始前，並讓 AI 重新開始（舊 session 的記憶已不符實際檔案）。 */
  rollback(p: string, t: string, request: string): Promise<void> {
    return this.lock(p, t, async () => {
      await this.deps.tasks.get(p, t);
      const s = this.slot(p, t);
      if (s.busy) throw new AppError('conflict', 'rollback_while_running');
      const rows = await this.deps.store.readLog(p, t);
      const row = rows.find((r): r is Extract<ChatRow, { role: 'user' }> => r.role === 'user' && r.request === request);
      if (!row?.checkpoint) throw new AppError('not_found', 'checkpoint_missing');
      const sha = row.checkpoint;
      await this.deps.worktree.restore(p, t, sha);
      const meta = await this.deps.store.readMeta(p, t);
      meta.sessions = {};
      meta.models = {};
      meta.seen = {};
      await this.deps.store.writeMeta(p, t, meta);
      const note: ChatRow = {
        at: new Date().toISOString(), role: 'event', rollback: true, request,
        text: `人把工作副本還原到指示「${row.text.slice(0, 120)}」開始之前；該指示及之後的檔案變更都已丟棄，重新確認檔案現況再繼續。`,
      };
      await this.deps.store.append(p, t, note);
      this.publish(p, t, { event: 'row', data: note });
      await this.deps.oplog.record({ action: 'chatrollback', project: p, task: t });
      this.deps.onChanged(p, t);
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
