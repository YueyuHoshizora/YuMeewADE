import { AppError } from '../shared/errors.ts';

/** Explicit non-secret overrides only; interpreter injection and credential persistence are forbidden. */
export function executionEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request');
  const entries = Object.entries(value);
  if (entries.length > 64) throw new AppError('bad_request');
  let bytes = 0;
  const out: Record<string, string> = {};
  for (const [key, val] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/u.test(key) || /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|API_KEY)|^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|ELECTRON_.*|PYTHONPATH|BASH_ENV|ENV|SHELLOPTS|COMSPEC)$/iu.test(key) || typeof val !== 'string' || val.length > 4096 || val.includes('\0')) throw new AppError('bad_request');
    bytes += Buffer.byteLength(key) + Buffer.byteLength(val);
    if (bytes > 16384) throw new AppError('bad_request');
    out[key] = val;
  }
  return out;
}
export function executionArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some(a => typeof a !== 'string' || a.length > 8192 || a.includes('\0')) || value.reduce((n: number, a: string) => n + Buffer.byteLength(a), 0) > 65536) throw new AppError('bad_request');
  return value as string[];
}
