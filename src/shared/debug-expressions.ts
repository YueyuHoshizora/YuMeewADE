import { AppError } from './errors.ts';

/** Supported watch grammar is identifiers joined by dots; no calls, brackets, getters or evaluation. */
export function debugWatchPath(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,7}$/u.test(value)) throw new AppError('bad_request');
  const parts = value.split('.');
  if (parts.some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) throw new AppError('bad_request');
  return parts;
}
/** Explicit Inspector condition only: path compared to a primitive literal. Conditions can execute target property getters. */
export function debugCondition(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 512) throw new AppError('bad_request');
  const match = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,7})\s*(===|!==|==|!=|<=|>=|<|>)\s*(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?|"(?:[^"\\\r\n]|\\["\\bfnrt]|\\u[0-9a-fA-F]{4})*")\s*$/u.exec(value);
  if (!match) throw new AppError('bad_request');
  debugWatchPath(match[1]);
  return `${match[1]} ${match[2]} ${match[3]}`;
}
