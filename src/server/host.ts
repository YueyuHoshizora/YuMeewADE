// 核心本體：持有目前的 App、HTTP 伺服器與即時連線。切換工作區時換上新的 App，port 與 SSE 連線都不中斷。

import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHttpServer, type HttpCore } from '../http/server.ts';
import { SseHub } from '../http/sse.ts';
import { configWriteTarget, expandHome, saveWorkspaceRoot, type Config } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/log.ts';
import { App, type AppOptions } from './app.ts';

export interface HostOptions {
  app?: AppOptions;
  /** 日誌寫進工作區的 .yumeewade/yumeewade.log（正式核心才開；測試不寫）。 */
  logs?: boolean;
}

export class CoreHost {
  readonly server: http.Server;
  private current: App;
  private readonly http: HttpCore;
  private readonly options: HostOptions;
  private readonly sse: SseHub;
  private relocating = false;

  constructor(config: Config, options: HostOptions = {}) {
    this.options = options;
    this.sse = new SseHub(config.limits.sseConnections, config.limits.heartbeatSeconds * 1000);
    this.current = this.build(config);
    this.http = createHttpServer(this.current);
    this.server = this.http.server;
  }

  get app(): App {
    return this.current;
  }

  async init(): Promise<void> {
    this.useLog(this.current);
    await this.current.init();
  }

  /**
   * 改用另一個工作區根目錄：建好新工作區、寫回設定檔後才換上，任何一步失敗都維持原工作區。
   * 原工作區的檔案不搬移也不刪除。
   */
  async relocate(input: string): Promise<string> {
    const expanded = expandHome(input.trim());
    if (!path.isAbsolute(expanded)) throw new AppError('bad_request', 'root_not_absolute');
    const root = path.resolve(expanded);
    const old = this.current;
    if (root === old.ws.root) return root;
    if (this.relocating || old.runner.running().length) throw new AppError('conflict', 'relocate_busy');
    this.relocating = true;
    try {
      const stat = await fs.stat(root).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err; });
      if (stat && !stat.isDirectory()) throw new AppError('bad_request', 'root_not_directory');
      const next = this.build({ ...old.config, workspace: { root } });
      try {
        await next.init();
      } catch (cause) {
        next.close();
        throw new AppError('bad_request', 'root_unwritable', { cause });
      }
      try {
        await saveWorkspaceRoot(configWriteTarget(old.config), root);
      } catch (err) {
        next.close();
        throw err;
      }
      this.current = next;
      this.http.mount(next);
      this.useLog(next);
      log.info('已切換工作區', { from: old.ws.root, to: root });
      await next.oplog.record({ action: 'workspace', from: old.ws.root });
      // 連線沿用，所有開著的視窗收到 changed 就會重抓新工作區的狀態
      next.changed();
      await old.shutdown();
      return root;
    } finally {
      this.relocating = false;
    }
  }

  async shutdown(): Promise<void> {
    try { await this.current.shutdown(); }
    finally { this.sse.closeAll(); }
  }

  /** 不等 AI 停止，直接釋放計時器與連線（測試收尾用）。 */
  close(): void {
    this.current.close();
    this.sse.closeAll();
  }

  private build(config: Config): App {
    return new App(config, { ...this.options.app, sse: this.sse, relocate: root => this.relocate(root) });
  }

  private useLog(app: App): void {
    if (this.options.logs) log.setFile(path.join(app.ws.root, '.yumeewade', 'yumeewade.log'));
  }
}
