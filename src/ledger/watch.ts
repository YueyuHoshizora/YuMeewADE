import { watch, promises as fs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { log } from '../shared/log.ts';
import { isValidProjectName, isValidTaskId } from '../shared/names.ts';
import type { Workspace } from './workspace.ts';

type Target = { kind: 'root' | 'internal' | 'projects' | 'project' | 'ai' | 'tasks' | 'chat'; project?: string };

/** Only ledger directories are watched; project bodies and worktrees are excluded. */
export class LedgerWatcher {
  private readonly ws: Workspace;
  private readonly changed: (project?: string, task?: string) => void;
  private readonly watchers = new Map<string, FSWatcher>();
  /** Which directory (dev:ino) each watcher is attached to; a path removed and recreated between rebuilds is a new directory. */
  private readonly identities = new Map<string, string>();
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private rebuilding = false;
  private dirty = false;

  constructor(ws: Workspace, changed: (project?: string, task?: string) => void) {
    this.ws = ws;
    this.changed = changed;
  }

  async start(): Promise<void> {
    await this.rebuild();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.identities.clear();
  }

  private schedule(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer || this.rebuilding) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.rebuild();
    }, 25);
    this.timer.unref();
  }

  private event(target: Target, filename: string | null): void {
    if (this.closed) return;
    if (target.kind === 'root') {
      if (filename === null || filename === 'roles.yaml') this.changed();
      if (filename === null || filename === 'Projects' || filename === '.yumeewade') this.schedule();
      return;
    }
    if (target.kind === 'internal') {
      // Logging a watch failure must not itself trigger another state refresh.
      if (filename !== null && (filename === 'yumeewade.log' || filename === 'yumeewade.log.old')) return;
      this.changed();
      return;
    }
    if (target.kind === 'projects') {
      this.changed();
      this.schedule();
      return;
    }
    if (target.kind === 'project' || target.kind === 'ai') {
      this.schedule();
      if (filename === null || (target.kind === 'project' ? filename === 'PROJECT.md' || filename === '.ai' : ['tasks', 'chat', 'start-pick.json'].includes(filename))) {
        this.changed(target.project);
      }
      return;
    }
    if (filename === null) {
      this.changed(target.project);
      this.schedule();
      return;
    }
    // .jsonl 每個工具事件都會追加；/api/state 只用它判斷「有沒有對話」，那由 runner 自己通知，不必每次追加都廣播。
    const suffix = target.kind === 'tasks' ? /\.md$/u : /\.(?:queue\.json|json)$/u;
    if (!suffix.test(filename)) return;
    const task = filename.replace(suffix, '');
    if (isValidTaskId(task)) this.changed(target.project, task);
  }

  private async rebuild(): Promise<void> {
    if (this.closed) return;
    if (this.rebuilding) {
      this.dirty = true;
      return;
    }
    this.rebuilding = true;
    this.dirty = false;
    try {
      const targets = new Map<string, Target>([
        [this.ws.root, { kind: 'root' }],
        [this.ws.internalDir, { kind: 'internal' }],
        [this.ws.projectsDir, { kind: 'projects' }],
      ]);
      const entries = await fs.readdir(this.ws.projectsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') log.error('無法讀取台帳監看目錄', error);
        return [];
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || !isValidProjectName(entry.name)) continue;
        const project = entry.name;
        targets.set(this.ws.projectDir(project), { kind: 'project', project });
        targets.set(path.join(this.ws.projectDir(project), '.ai'), { kind: 'ai', project });
        targets.set(this.ws.tasksDir(project), { kind: 'tasks', project });
        targets.set(path.join(this.ws.projectDir(project), '.ai', 'chat'), { kind: 'chat', project });
      }
      for (const [dir, target] of targets) {
        const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') log.error('無法檢查台帳監看目錄', error);
          return null;
        });
        if (this.closed) return;
        if (!stat?.isDirectory()) {
          targets.delete(dir);
          for (const child of targets.keys()) {
            if (child.startsWith(dir + path.sep)) targets.delete(child);
          }
          continue;
        }
        const identity = `${stat.dev}:${stat.ino}`;
        const existing = this.watchers.get(dir);
        if (existing && this.identities.get(dir) === identity) continue;
        existing?.close();
        this.watchers.delete(dir);
        try {
          const watcher = watch(dir, { recursive: false, persistent: false }, (_event, filename) => {
            this.event(target, filename === null ? null : filename.toString());
          });
          watcher.on('error', (error) => {
            log.error('台帳檔案監看失敗', error);
            watcher.close();
            if (this.watchers.get(dir) === watcher) this.watchers.delete(dir);
          });
          this.watchers.set(dir, watcher);
          this.identities.set(dir, identity);
        } catch (error) {
          log.error('無法建立台帳檔案監看', error);
        }
      }
      for (const [dir, watcher] of this.watchers) {
        if (!targets.has(dir)) {
          watcher.close();
          this.watchers.delete(dir);
          this.identities.delete(dir);
        }
      }
    } catch (error) {
      log.error('無法更新台帳檔案監看', error);
    } finally {
      this.rebuilding = false;
      if (this.dirty) this.schedule();
    }
  }
}
