import { DEFAULT_CONFIG, type CliCommandConfig } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import type { SendOptions } from './provider.ts';

/** Fail closed on unverified deployment profiles; base/full-access flags never enter review. */
export function readonlyConfigured(ai: 'claude' | 'codex', cfg: CliCommandConfig): boolean {
  return JSON.stringify(cfg.readonlyArgs) === JSON.stringify(DEFAULT_CONFIG.cli[ai].readonlyArgs);
}
export function reviewArgs(ai: 'claude' | 'codex', cfg: CliCommandConfig, opts: SendOptions): string[] {
  if (!readonlyConfigured(ai, cfg) || opts.resumeId || opts.addDirs?.length || opts.slashCommand) {
    throw new AppError('bad_request', 'cli_unsupported');
  }
  return [...cfg.readonlyArgs!];
}
export function refuseReview(opts: SendOptions): void {
  if (opts.readonly) throw new AppError('bad_request', 'cli_unsupported');
}
