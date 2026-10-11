// 核心組裝：config → 工作區 → 各層物件。HTTP 路由只透過 App 取用。

import { createRequire } from 'node:module';
import { AiCatalog } from '../ai/catalog.ts';
import { UsageBoard } from '../ai/usage.ts';
import { ChatRunner } from '../chat/runner.ts';
import { ChatStore } from '../chat/store.ts';
import { cleanupUploads } from '../chat/attachments.ts';
import type { CliProvider } from '../cli/provider.ts';
import { createProviders } from '../cli/providers.ts';
import type { CredentialAccounts } from '../cli/accounts.ts';
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
import type { AppState, ChatEvent, Roles, UsageState } from '../shared/types.ts';
import { fetchCodexReset } from '../ai/codex-reset.ts';
import { UpdateWatcher, fetchLatestRelease } from '../system/update.ts';
import { buildState, type StateSnapshot } from '../state/state.ts';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

export interface AppOptions {
  /** 測試用：取代真實 CLI。 */
  providers?: Record<string, CliProvider>;
  /** App 層級的加密憑證，跨工作區沿用；測試可直接注入 providers。 */
  accounts?: CredentialAccounts;
  /** 測試用：AI 模型快取所在的家目錄（預設 os.homedir()）。 */
  home?: string;
  /** 切換工作區；由 CoreHost 提供（它才能換掉整個 App）。 */
  relocate?: (root: string) => Promise<string>;
  /** CoreHost 持有的即時連線；切換工作區時沿用，網頁不必斷線重連。沒給就自建並在 close 時關閉。 */
  sse?: SseHub;
}

/** OAuth 需要使用者在瀏覽器操作，給 5 分鐘。 */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

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
  readonly update: UpdateWatcher;
  private readonly providers: Record<string, CliProvider>;
  private readonly accounts: CredentialAccounts | undefined;
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
    if (!options.providers && !options.accounts) throw new Error('Credential storage is required');
    this.accounts = options.accounts;
    this.config = config;
    this.relocate = options.relocate ?? (() => Promise.reject(new AppError('conflict', 'relocate_busy')));
    this.ws = new Workspace(config.workspace.root);
    this.projects = new ProjectLedger(this.ws);
    this.tasks = new TaskLedger(this.ws);
    this.completion = new CompletionStore(this.ws);
    this.settings = new SettingsStore(this.ws, config, async (ai, directory) => {
      if (this.accounts) await this.captureCredentials(ai, directory);
    }, async (ai, directory) => {
      if (!this.accounts) throw new AppError('unavailable', 'credentials_unavailable');
      const cli = this.config.cli[ai as 'claude' | 'codex' | 'grok' | 'gemini'];
      if (!cli.loginArgs.length) throw new AppError('bad_request', 'cli_unsupported');
      try { await this.accounts.login(ai, directory, cli.command, cli.loginArgs, LOGIN_TIMEOUT_MS); }
      catch { throw new AppError('unavailable', 'login_failed'); }
    }, ai => {
      if (!this.accounts) throw new AppError('unavailable', 'credentials_unavailable');
      return this.accounts.newProfileDirectory(ai);
    }, async (ai, directory) => {
      if (this.accounts) {
        try { await this.accounts.activate(ai, directory); }
        catch { throw new AppError('unavailable', 'credentials_unavailable'); }
      }
    });
    this.order = new OrderStore(this.ws);
    this.oplog = new OpLog(this.ws);
    this.worktree = new WorktreeService({ ws: this.ws, projects: this.projects, tasks: this.tasks, diffBytes: config.limits.diffBytes });
    this.verify = new VerifyService({ ws: this.ws, projects: this.projects, tasks: this.tasks, config, isRunning: (project, task) => this.runner.isRunning(project, task) });
    this.ai = new AiCatalog({ config, ws: this.ws, settings: this.settings, ...(options.home ? { home: options.home } : {}), ...(options.accounts ? { accounts: options.accounts } : {}) });
    this.store = new ChatStore(this.ws);
    this.ownsSse = !options.sse;
    this.sse = options.sse ?? new SseHub(config.limits.sseConnections, config.limits.heartbeatSeconds * 1000);
    this.sendLimiter = new RateLimiter(config.limits.sendPerMinute);
    this.usage = new UsageBoard(usage => this.sse.publish(GLOBAL, { event: 'usage', data: usage }));
    this.update = new UpdateWatcher(pkg.version, () => fetchLatestRelease(config.update.repo), () => this.changed());
    this.providers = options.providers ?? createProviders(config, options.accounts!);
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
      onUsage: (ai, ev, account) => this.usage.record(ai, ev, account),
    });
    // AI 一開始動手，之前的驗證結果就不再代表目前的檔案。
    this.runner.on('event', (project: string, task: string, ev: ChatEvent) => { if (ev.event === 'busy') this.verify.invalidate(project, task); });
  }

  async init(): Promise<void> {
    await this.ws.init();
    if (this.accounts) {
      const settings = await this.settings.get();
      for (const ai of ['claude', 'codex', 'grok', 'gemini']) {
        // The CLI's own default login is never read; only accounts added through OAuth are imported.
        for (const directory of (settings.accounts[ai] ?? []).map(account => account.configDir)) {
          try { await this.captureCredentials(ai, directory); }
          catch { log.warn('帳號憑證尚未匯入', { ai }); }
        }
      }
    }
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
    // 帳戶查詢不擋啟動；每輪重新讀設定，新增／移除的帳戶即時生效。
    if (this.config.update.enabled) void this.update.poll(this.config.update.checkHours * 60 * 60 * 1000);
    void this.usage.pollCodexReset(fetchCodexReset, 60 * 60 * 1000);
    void this.usage.poll(this.providers, this.config.limits.usagePollSeconds * 1000, async () => (await this.settings.get()).accounts);
  }

  async refreshUsage(): Promise<UsageState> {
    await this.usage.load(this.providers, (await this.settings.get()).accounts);
    return this.usage.snapshot();
  }

  private async captureCredentials(ai: string, directory?: string): Promise<void> {
    if (!this.accounts) throw new AppError('unavailable', 'credentials_unavailable');
    try { await this.accounts.import(ai, directory); }
    catch { throw new AppError('unavailable', 'credentials_unavailable'); }
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
    const update = this.update.snapshot();
    return { ...value, running: this.runner.running(), unread: this.runner.unread(), usage: this.usage.snapshot(), ...(update ? { update } : {}) };
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
    this.update.close();
    if (this.ownsSse) this.sse.closeAll();
  }
}
