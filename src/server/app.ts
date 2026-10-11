// 核心組裝：config → 工作區 → 各層物件。HTTP 路由只透過 App 取用。

import { createRequire } from 'node:module';
import { AiCatalog } from '../ai/catalog.ts';
import { UsageBoard } from '../ai/usage.ts';
import { ChatRunner } from '../chat/runner.ts';
import { ChatStore } from '../chat/store.ts';
import { cleanupUploads } from '../chat/attachments.ts';
import type { CliProvider } from '../cli/provider.ts';
import { createProviders } from '../cli/providers.ts';
import { WorktreeService } from '../git/worktree.ts';
import { VerifyService } from '../git/verify.ts';
import { RateLimiter } from '../http/ratelimit.ts';
import { GLOBAL, SseHub, taskKey } from '../http/sse.ts';
import { CompletionStore } from '../ledger/completion.ts';
import { OpLog } from '../ledger/oplog.ts';
import { OrderStore } from '../ledger/order.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { SettingsStore } from '../ledger/settings.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { Workspace } from '../ledger/workspace.ts';
import { LedgerWatcher } from '../ledger/watch.ts';
import { loadRoles } from '../roles/roles.ts';
import type { Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';
import type { AppState, ChatEvent, Roles } from '../shared/types.ts';
import { buildState, type StateSnapshot } from '../state/state.ts';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

/** 向 CLI 重新查額度的間隔；額度在終端機或其他裝置上也會變。 */
const USAGE_POLL_MS = 120_000;

export interface AppOptions {
  /** 測試用：取代真實 CLI。 */
  providers?: Record<string, CliProvider>;
  /** 測試用：AI 模型快取所在的家目錄（預設 os.homedir()）。 */
  home?: string;
  /** 切換工作區；由 CoreHost 提供（它才能換掉整個 App）。 */
  relocate?: (root: string) => Promise<string>;
  /** CoreHost 持有的即時連線；切換工作區時沿用，網頁不必斷線重連。沒給就自建並在 close 時關閉。 */
  sse?: SseHub;
}

export class App {
  readonly config: Config;
  readonly version = pkg.version;
  readonly ws: Workspace;
  readonly projects: ProjectLedger;
  readonly tasks: TaskLedger;
  readonly completion: CompletionStore;
  readonly settings: SettingsStore;
  readonly order: OrderStore;
  readonly oplog: OpLog;
  readonly worktree: WorktreeService;
  readonly verify: VerifyService;
  readonly ai: AiCatalog;
  readonly store: ChatStore;
  readonly runner: ChatRunner;
  readonly usage: UsageBoard;
  private readonly providers: Record<string, CliProvider>;
  readonly sse: SseHub;
  readonly sendLimiter: RateLimiter;
  readonly relocate: (root: string) => Promise<string>;

  private changeTimer: NodeJS.Timeout | null = null;
  private uploadTimer: NodeJS.Timeout | null = null;
  private uploadCleanup: Promise<void> | null = null;
  private pendingChange: { project?: string; task?: string } | null = null;
  private readonly ownsSse: boolean;
  private watcher: LedgerWatcher | null = null;
  private stateGeneration = 0;
  private stateCache: { value: StateSnapshot; expires: number } | null = null;
  private stateFlight: { generation: number; promise: Promise<StateSnapshot> } | null = null;

  constructor(config: Config, options: AppOptions = {}) {
    this.config = config;
    this.relocate = options.relocate ?? (() => Promise.reject(new AppError('conflict', 'relocate_busy')));
    this.ws = new Workspace(config.workspace.root);
    this.projects = new ProjectLedger(this.ws);
    this.tasks = new TaskLedger(this.ws);
    this.completion = new CompletionStore(this.ws);
    this.settings = new SettingsStore(this.ws, config);
    this.order = new OrderStore(this.ws);
    this.oplog = new OpLog(this.ws);
    this.worktree = new WorktreeService({ ws: this.ws, projects: this.projects, tasks: this.tasks, diffBytes: config.limits.diffBytes });
    this.verify = new VerifyService({ ws: this.ws, projects: this.projects, tasks: this.tasks, config, isRunning: (project, task) => this.runner.isRunning(project, task) });
    this.ai = new AiCatalog({ config, ws: this.ws, settings: this.settings, ...(options.home ? { home: options.home } : {}) });
    this.store = new ChatStore(this.ws);
    this.ownsSse = !options.sse;
    this.sse = options.sse ?? new SseHub(config.limits.sseConnections, config.limits.heartbeatSeconds * 1000);
    this.sendLimiter = new RateLimiter(config.limits.sendPerMinute);
    this.usage = new UsageBoard(usage => this.sse.publish(GLOBAL, { event: 'usage', data: usage }));
    this.providers = options.providers ?? createProviders(config);
    this.runner = new ChatRunner({
      ws: this.ws,
      store: this.store,
      projects: this.projects,
      tasks: this.tasks,
      completion: this.completion,
      worktree: this.worktree,
      settings: this.settings,
      oplog: this.oplog,
      verify: (project, task) => this.verify.run(project, task),
      roles: () => this.roles(),
      providers: this.providers,
      limits: config.limits,
      publish: (project, task, ev) => this.sse.publish(taskKey(project, task), ev),
      watching: (project, task) => this.sse.watching(taskKey(project, task)),
      onChanged: (project, task) => this.changed(project, task),
      onUsage: (ai, ev) => this.usage.record(ai, ev),
    });
    // AI 一開始動手，之前的驗證結果就不再代表目前的檔案。
    this.runner.on('event', (project: string, task: string, ev: ChatEvent) => { if (ev.event === 'busy') this.verify.invalidate(project, task); });
  }

  async init(): Promise<void> {
    await this.ws.init();
    await this.store.recoverInterrupted();
    await cleanupUploads(this.ws, this.store);
    this.uploadTimer = setInterval(() => {
      if (this.uploadCleanup) return;
      this.uploadCleanup = cleanupUploads(this.ws, this.store)
        .catch(err => { log.error('附件清理失敗', err); })
        .finally(() => { this.uploadCleanup = null; });
    }, 60 * 60 * 1000);
    this.uploadTimer.unref();
    this.watcher = new LedgerWatcher(this.ws, (project, task) => this.changed(project, task));
    await this.watcher.start();
    // 向各 CLI 查帳號目前額度（Codex 走 app-server，失敗退回本機紀錄）；不擋啟動，查到會以 usage 事件推給客戶端，之後定期更新。
    void this.usage.poll(this.providers, USAGE_POLL_MS);
  }

  /** 每次讀檔：roles.yaml 可手改，不快取。 */
  roles(): Promise<Roles> {
    return loadRoles(this.ws.rolesFile);
  }

  async state(): Promise<AppState> {
    let value = this.stateCache && this.stateCache.expires > Date.now() ? this.stateCache.value : null;
    if (!value) {
      const generation = this.stateGeneration;
      let flight = this.stateFlight;
      if (!flight || flight.generation !== generation) {
        flight = { generation, promise: buildState(this) };
        this.stateFlight = flight;
      }
      try {
        value = await flight.promise;
        // An external edit during the build must not bless an older snapshot.
        if (generation === this.stateGeneration) {
          this.stateCache = { value, expires: Date.now() + 5000 };
        }
      } finally {
        if (this.stateFlight === flight) this.stateFlight = null;
      }
    }
    return { ...value, running: this.runner.running(), unread: this.runner.unread(), usage: this.usage.snapshot() };
  }

  /** 通知所有客戶端重抓 /api/state；100ms 內的多次變更合併成一次。 */
  changed(project?: string, task?: string): void {
    this.stateGeneration++;
    this.stateCache = null;
    if (this.pendingChange === null) this.pendingChange = { ...(project ? { project } : {}), ...(task ? { task } : {}) };
    else if (this.pendingChange.project !== project || this.pendingChange.task !== task) this.pendingChange = {};
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const data = this.pendingChange ?? {};
      this.pendingChange = null;
      this.sse.publish(GLOBAL, { event: 'changed', data });
    }, 100);
    this.changeTimer.unref();
  }

  async shutdown(): Promise<void> {
    try { await Promise.all([this.runner.stopAll(), this.verify.stopAll()]); }
    finally { this.close(); }
  }

  close(): void {
    this.verify.close();
    clearTimeout(this.changeTimer ?? undefined);
    clearInterval(this.uploadTimer ?? undefined);
    this.uploadTimer = null;
    this.watcher?.close();
    this.usage.close();
    if (this.ownsSse) this.sse.closeAll();
  }
}
