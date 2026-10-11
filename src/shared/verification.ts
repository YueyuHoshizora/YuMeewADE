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
