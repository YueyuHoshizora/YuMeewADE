import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BackupService } from '../ledger/backup.ts';
import type { Workspace } from '../ledger/workspace.ts';
import { healthCheck, safeVersion, type HealthOptions } from './health.ts';
import { AppError } from '../shared/errors.ts';
import type { CareDiagnostics, CareHealth } from '../shared/types.ts';
import type { CareLifecycle, CareSchedule } from '../shared/backup-types.ts';
import { writeJson } from '../shared/fsx.ts';
import { createHash } from 'node:crypto';

export interface CareOptions extends HealthOptions {
  ws: Workspace;
  version: string;
  privateDirectory?: string;
  reserve: <T>(work: () => Promise<T>) => Promise<T>;
  counts: () => Promise<{ projects: number; tasks: number; running: number }>;
  notifyBackupFailure?: () => void;
}
/** Construct by selecting primitive allowlisted fields, never recursively redact arbitrary app state. */
export function diagnosticPayload(health: CareHealth, version: string, counts: { projects: number; tasks: number; running: number }): CareDiagnostics {
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    format: 1, versions: { app: safeVersion(version), node: safeVersion(health.node), electron: health.electron === null ? null : safeVersion(health.electron), git: safeVersion(health.git.version) },
    configuration: { loopbackOnly: health.boundToLoopback === true, workspace: '[workspace]' },
    capabilities: { writable: health.writable === true, loopback: health.loopback === true, git: health.git.available === true, signedBuild: health.buildTrust === 'signed' },
    providers: health.clis.filter(cli => ['claude', 'codex', 'grok', 'gemini'].includes(cli.name)).map(cli => ({ name: cli.name, available: cli.available === true, version: safeVersion(cli.version), fullAccess: cli.fullAccess === true, loginState: ['stored', 'missing'].includes(cli.loginState) ? cli.loginState : 'unknown' })),
    counts: { projects: count(counts.projects), tasks: count(counts.tasks), running: count(counts.running) },
    errorCodes: [...(health.writable ? [] : ['workspace_not_writable']), ...(health.loopback ? [] : ['loopback_unavailable']), ...(health.git.available ? [] : ['git_unavailable']), ...(health.boundToLoopback ? [] : ['non_loopback_binding']), ...(health.buildTrust === 'signed' ? [] : ['build_trust_unverified'])],
  };
}
export class CareService {
  readonly backups: BackupService;
  private closed = false;
  private readonly directory: string;
  private readonly options: CareOptions;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly lifecycleFile: string;
  private lifecycle: CareLifecycle = { schedule: { enabled: false, intervalHours: 24, retention: 10, includeExternal: true }, running: false, lastAttempt: null, lastSuccess: null, lastFailure: null, nextAttempt: null };
  constructor(options: CareOptions) {
    this.options = options;
    this.directory = options.privateDirectory ?? path.join(os.homedir(), '.yumeewade', 'care');
    this.backups = new BackupService(options.ws, path.join(this.directory, 'backups'));
    this.lifecycleFile = path.join(this.directory, `schedule-${createHash('sha256').update(path.resolve(options.ws.root)).digest('hex')}.json`);
  }
  private check(): void { if (this.closed) throw new AppError('unavailable', 'care_closed'); }
  health(network = false): Promise<CareHealth> { this.check(); return healthCheck(this.options, network); }
  async backup(includeExternal: boolean) {
    this.check();
    return this.options.reserve(async () => { const backup = await this.backups.create(includeExternal); if (backup.complete) await this.backups.retain(this.lifecycle.schedule.retention); return backup; });
  }
  restore(id: string, destination: string) { this.check(); return this.options.reserve(() => this.backups.restore(id, destination)); }
  export(id: string, password: string, consume: (file: string) => Promise<void>): Promise<void> {
    this.check(); return this.options.reserve(() => this.backups.export(id, password, consume));
  }
  import(input: AsyncIterable<Uint8Array>, password: string, destination: string): Promise<{ root: string }> {
    this.check(); return this.options.reserve(() => this.backups.import(input, password, destination));
  }
  async init(): Promise<void> {
    this.check();
    try {
      const stat = await fs.lstat(this.lifecycleFile); if (!stat.isFile() || stat.size > 16384) throw new AppError('conflict', 'care_backup_invalid');
      const value = JSON.parse(await fs.readFile(this.lifecycleFile, 'utf8')) as CareLifecycle;
      this.validateSchedule(value.schedule);
      for (const date of [value.lastAttempt, value.lastSuccess, value.nextAttempt]) if (date !== null && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) throw new AppError('conflict', 'care_backup_invalid');
      if (value.lastFailure !== null && value.lastFailure !== 'care_backup_invalid') throw new AppError('conflict', 'care_backup_invalid');
      this.lifecycle = { ...value, running: false };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.arm();
  }
  scheduleStatus(): CareLifecycle { this.check(); return structuredClone(this.lifecycle); }
  private validateSchedule(schedule: CareSchedule): void {
    if (!schedule || typeof schedule.enabled !== 'boolean' || typeof schedule.includeExternal !== 'boolean' || !Number.isInteger(schedule.intervalHours) || schedule.intervalHours < 1 || schedule.intervalHours > 8760 || !Number.isInteger(schedule.retention) || schedule.retention < 1 || schedule.retention > 1000) throw new AppError('bad_request');
  }
  async setSchedule(schedule: CareSchedule): Promise<CareLifecycle> {
    this.check(); this.validateSchedule(schedule);
    this.lifecycle.schedule = { ...schedule };
    this.lifecycle.nextAttempt = schedule.enabled ? new Date(Date.now() + schedule.intervalHours * 3600000).toISOString() : null;
    await this.saveLifecycle(); this.arm(); return this.scheduleStatus();
  }
  private async saveLifecycle(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new AppError('forbidden');
    await writeJson(this.lifecycleFile, this.lifecycle); await fs.chmod(this.lifecycleFile, 0o600);
  }
  private arm(): void {
    clearTimeout(this.timer);
    if (this.closed || !this.lifecycle.schedule.enabled || this.running) return;
    const next = this.lifecycle.nextAttempt ?? new Date(Date.now() + this.lifecycle.schedule.intervalHours * 3600000).toISOString(); this.lifecycle.nextAttempt = next;
    this.timer = setTimeout(() => { this.running = this.scheduledBackup().finally(() => { this.running = undefined; this.arm(); }); }, Math.min(2147483647, Math.max(0, Date.parse(next) - Date.now())));
    this.timer.unref();
  }
  private async scheduledBackup(): Promise<void> {
    if (this.closed) return;
    // Long intervals use capped timers; do not run before the persisted due date.
    if (Date.parse(this.lifecycle.nextAttempt ?? '') > Date.now()) return;
    this.lifecycle.running = true; this.lifecycle.lastAttempt = new Date().toISOString();
    try {
      await this.saveLifecycle(); await this.backup(this.lifecycle.schedule.includeExternal);
      this.lifecycle.lastSuccess = new Date().toISOString(); this.lifecycle.lastFailure = null;
    } catch {
      this.lifecycle.lastFailure = 'care_backup_invalid'; this.options.notifyBackupFailure?.();
    } finally {
      this.lifecycle.running = false;
      this.lifecycle.nextAttempt = this.lifecycle.schedule.enabled ? new Date(Date.now() + this.lifecycle.schedule.intervalHours * 3600000).toISOString() : null;
      try { await this.saveLifecycle(); } catch { this.lifecycle.lastFailure = 'care_backup_invalid'; this.options.notifyBackupFailure?.(); }
    }
  }
  async diagnostics(): Promise<Buffer> {
    this.check();
    const payload = diagnosticPayload(await this.health(), this.options.version, await this.options.counts());
    const directory = path.join(this.directory, 'diagnostics');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new AppError('forbidden');
    await fs.chmod(directory, 0o700);
    const bytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n');
    const target = path.join(directory, `${randomUUID()}.json`);
    const handle = await fs.open(target, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return bytes;
  }
  async close(): Promise<void> { this.closed = true; clearTimeout(this.timer); await this.running; }
}
