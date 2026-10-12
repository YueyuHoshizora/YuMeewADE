import type { VerificationCheck } from './types.ts';
import { AppError } from './errors.ts';

export function parseVerificationChecks(value: unknown): VerificationCheck[] {
  if (!Array.isArray(value) || value.length > 20) throw new AppError('bad_request', 'field_type', { field: 'checks' });
  const names = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.command !== 'string') throw new AppError('bad_request', 'field_type', { field: 'checks' });
    const name = item.name.trim();
    const command = item.command.trim();
    if (!name || name.length > 80 || /[\r\n\0]/u.test(name) || names.has(name) || !command || command.length > 500 || /[\r\n\0]/u.test(item.command)) throw new AppError('bad_request', 'field_type', { field: 'checks' });
    names.add(name);
    return { name, command };
  });
}

/** Relative bounded globs; only explicitly declared outputs may be ignored. */
export interface VerificationInputModel { inputs?: string[]; outputs?: string[]; }

export function parseVerificationInputModel(value: unknown): VerificationInputModel {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => key !== 'inputs' && key !== 'outputs')) throw new AppError('bad_request');
  const result: VerificationInputModel = {};
  for (const key of ['inputs', 'outputs'] as const) {
    if (object[key] === undefined) continue;
    const patterns = object[key];
    if (!Array.isArray(patterns) || patterns.length > 100 || (key === 'inputs' && !patterns.length)) throw new AppError('bad_request');
    result[key] = [...new Set(patterns.map(pattern => {
      if (typeof pattern !== 'string' || !pattern || pattern.length > 512 || pattern.startsWith('/') || /[\\:\0\r\n?[\]{}!]/u.test(pattern) || pattern.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || (part.includes('**') && part !== '**'))) throw new AppError('bad_request');
      return pattern;
    }))];
  }
  return result;
}
