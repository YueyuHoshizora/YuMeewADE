// 核心組裝：config → 工作區 → 各層物件。HTTP 路由只透過 App 取用。

import { createRequire } from 'node:module';
import { AiCatalog } from '../ai/catalog.ts';
import { ChatRunner } from '../chat/runner.ts';
import { ChatStore } from '../chat/store.ts';
import type { CliProvider } from '../cli/provider.ts';
import { createProviders } from '../cli/providers.ts';
import { WorktreeService } from '../git/worktree.ts';
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
import type { AppState, Roles } from '../shared/types.ts';
import { buildState } from '../state/state.ts';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

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
  readonly ai: AiCatalog;
  readonly store: ChatStore;
  readonly runner: ChatRunner;
  readonly sse: SseHub;
  readonly sendLimiter: RateLimiter;
  readonly relocate: (root: string) => Promise<string>;

  private changeTimer: NodeJS.Timeout | null = null;
  private pendingChange: { project?: string; task?: string } | null = null;
  private readonly ownsSse: boolean;
  private watcher: LedgerWatcher | null = null;

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
    this.ai = new AiCatalog({ config, ws: this.ws, settings: this.settings, ...(options.home ? { home: options.home } : {}) });
    this.store = new ChatStore(this.ws);
    this.ownsSse = !options.sse;
    this.sse = options.sse ?? new SseHub(config.limits.sseConnections, config.limits.heartbeatSeconds * 1000);
    this.sendLimiter = new RateLimiter(config.limits.sendPerMinute);
    this.runner = new ChatRunner({
      ws: this.ws,
      store: this.store,
      projects: this.projects,
      tasks: this.tasks,
      completion: this.completion,
      worktree: this.worktree,
      settings: this.settings,
      oplog: this.oplog,
      roles: () => this.roles(),
      providers: options.providers ?? createProviders(config),
      limits: config.limits,
      publish: (project, task, ev) => this.sse.publish(taskKey(project, task), ev),
      watching: (project, task) => this.sse.watching(taskKey(project, task)),
      onChanged: (project, task) => this.changed(project, task),
    });
  }

  async init(): Promise<void> {
    await this.ws.init();
    await this.store.recoverInterrupted();
    this.watcher = new LedgerWatcher(this.ws, (project, task) => this.changed(project, task));
    await this.watcher.start();
  }

  /** 每次讀檔：roles.yaml 可手改，不快取。 */
  roles(): Promise<Roles> {
    return loadRoles(this.ws.rolesFile);
  }

  state(): Promise<AppState> {
    return buildState(this);
  }

  /** 通知所有客戶端重抓 /api/state；100ms 內的多次變更合併成一次。 */
  changed(project?: string, task?: string): void {
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
    try { await this.runner.stopAll(); }
    finally { this.close(); }
  }

  close(): void {
    clearTimeout(this.changeTimer ?? undefined);
    this.watcher?.close();
    if (this.ownsSse) this.sse.closeAll();
  }
}
