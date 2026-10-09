// 核心組裝：config → 工作區 → 各層物件。HTTP 路由只透過 App 取用。

import { createRequire } from 'node:module';
import { ChatRunner } from '../chat/runner.ts';
import { ChatStore } from '../chat/store.ts';
import { ClaudeCliProvider } from '../cli/claude.ts';
import { CodexCliProvider } from '../cli/codex.ts';
import { MockCliProvider } from '../cli/mock.ts';
import type { CliProvider } from '../cli/provider.ts';
import { WorktreeService } from '../git/worktree.ts';
import { RateLimiter } from '../http/ratelimit.ts';
import { SseHub } from '../http/sse.ts';
import { ProjectLedger } from '../ledger/projects.ts';
import { TaskLedger } from '../ledger/tasks.ts';
import { Workspace } from '../ledger/workspace.ts';
import { loadRoles } from '../roles/roles.ts';
import type { Config } from '../shared/config.ts';
import type { CliInfo, Roles } from '../shared/types.ts';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

export class App {
  readonly config: Config;
  readonly ws: Workspace;
  readonly projects: ProjectLedger;
  readonly tasks: TaskLedger;
  readonly store: ChatStore;
  readonly worktree: WorktreeService;
  readonly providers: Record<string, CliProvider>;
  readonly runner: ChatRunner;
  readonly sse: SseHub;
  readonly sendLimiter: RateLimiter;
  readonly version = pkg.version;

  constructor(config: Config, options: { providers?: Record<string, CliProvider> } = {}) {
    this.config = config;
    this.ws = new Workspace(config.workspace.root);
    this.projects = new ProjectLedger(this.ws);
    this.tasks = new TaskLedger(this.ws);
    this.store = new ChatStore(this.ws);
    this.worktree = new WorktreeService(this.ws, config.limits.diffBytes);
    this.providers = options.providers ?? {
      claude: new ClaudeCliProvider(config.cli.claude, config.cli.envPassthrough),
      codex: new CodexCliProvider(config.cli.codex, config.cli.envPassthrough),
      mock: new MockCliProvider(),
    };
    this.runner = new ChatRunner({
      ws: this.ws,
      store: this.store,
      tasks: this.tasks,
      roles: () => this.roles(),
      providers: this.providers,
      limits: config.limits,
      prepareCwd: (project, task) => this.worktree.ensure(project, task),
    });
    this.sse = new SseHub(config.limits.sseConnections, config.limits.heartbeatSeconds * 1000);
    this.sendLimiter = new RateLimiter(config.limits.sendPerMinute);
    this.runner.on('event', (project: string, task: string, ev) => this.sse.publish(`${project}\u0000${task}`, ev));
  }

  async init(): Promise<void> {
    await this.ws.init();
  }

  /** 每次讀檔：roles.yaml 可手改，不快取。 */
  roles(): Promise<Roles> {
    return loadRoles(this.ws.rolesFile);
  }

  async cliInfo(): Promise<CliInfo[]> {
    return Promise.all(Object.values(this.providers).map(async (p) => ({ name: p.name, available: await p.available(), dangerous: p.dangerous })));
  }

  close(): void {
    this.sse.closeAll();
  }
}
