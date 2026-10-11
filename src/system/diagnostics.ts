import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BackupService } from '../ledger/backup.ts';
import type { Workspace } from '../ledger/workspace.ts';
import { healthCheck, safeVersion, type HealthOptions } from './health.ts';
import { AppError } from '../shared/errors.ts';
import type { CareDiagnostics, CareHealth } from '../shared/types.ts';

export interface CareOptions extends HealthOptions {
  ws: Workspace;
  version: string;
  privateDirectory?: string;
  reserve: <T>(work: () => Promise<T>) => Promise<T>;
  counts: () => Promise<{ projects: number; tasks: number; running: number }>;
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
  constructor(options: CareOptions) {
    this.options = options;
    this.directory = options.privateDirectory ?? path.join(os.homedir(), '.yumeewade', 'care');
    this.backups = new BackupService(options.ws, path.join(this.directory, 'backups'));
  }
  private check(): void { if (this.closed) throw new AppError('unavailable', 'care_closed'); }
  health(network = false): Promise<CareHealth> { this.check(); return healthCheck(this.options, network); }
  backup(includeExternal: boolean) { this.check(); return this.options.reserve(() => this.backups.create(includeExternal)); }
  restore(id: string, destination: string) { this.check(); return this.options.reserve(() => this.backups.restore(id, destination)); }
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
  close(): void { this.closed = true; }
}
