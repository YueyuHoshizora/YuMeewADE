import { EFFORTS } from './types.ts';

export const MODEL_NAME_MAX = 200;

/** Model ids become the CLI argv value after `--model`; control characters and a leading '-' are never real ids. '' means the provider default. */
export function validModelName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MODEL_NAME_MAX && !/\p{Cc}/u.test(value) && !value.startsWith('-');
}

/** '' means the provider default; anything else must be a known reasoning effort. */
export function validEffort(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || EFFORTS.includes(value));
}
