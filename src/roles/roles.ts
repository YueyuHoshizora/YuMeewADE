// 角色只決定工作分工與模型；CLI 權限由每輪設定決定。
import { promises as fs } from 'node:fs';
import { AppError } from '../shared/errors.ts';
import { atomicWrite } from '../shared/fsx.ts';
import { HUMAN, type AiPick, type RoleInput, type RoleSlot, type Roles, type Task } from '../shared/types.ts';
import { parseYamlMap, YamlError, type YamlValue } from '../shared/yaml.ts';
export { HUMAN } from '../shared/types.ts';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function validateSlot(s: RoleSlot): void {
  if (!s || !['claude', 'codex', 'mock', HUMAN].includes(s.cli) || typeof s.model !== 'string' || typeof s.effort !== 'string' || (s.effort && !EFFORTS.includes(s.effort))) throw new AppError('bad_request', 'invalid_effort');
  if (s.cli === HUMAN && (s.model || s.effort)) throw new AppError('bad_request');
}
function slot(v: YamlValue | undefined, where: string): RoleSlot | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string') || (v[0] === HUMAN ? v.length !== 1 : v.length !== 3)) throw new YamlError(`${where} 必須是 [cli, model, effort] 或 [人]`, 0);
  const s = { cli: String(v[0]), model: String(v[1] ?? ''), effort: String(v[2] ?? '') }; validateSlot(s); return s;
}
export function parseRoles(text: string): Roles {
  const raw = parseYamlMap(text)['roles'];
  const roles: Roles['roles'] = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [name, def] of Object.entries(raw)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new YamlError(`roles.${name} 必須是 map`, 0);
    const main = slot(def['main'], name); if (!main) throw new YamlError(`roles.${name}.main 必填`, 0);
    const backup = slot(def['backup'], name);
    roles[name] = { main, ...(backup ? { backup } : {}), job: String(def['job'] ?? '') };
  }
  return { roles };
}
export async function loadRoles(file: string): Promise<Roles> { return parseRoles(await fs.readFile(file, 'utf8')); }
export async function writeRoles(file: string, inputs: RoleInput[]): Promise<Roles> {
  if (!Array.isArray(inputs)) throw new AppError('bad_request');
  const names = new Set<string>();
  const lines = ['roles:'];
  const encode = (s: RoleSlot) => s.cli === HUMAN ? '[人]' : `[${[s.cli, s.model, s.effort].map(x => JSON.stringify(x)).join(', ')}]`;
  for (const r of inputs) {
    if (!r || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60 || /[\r\n\0]/u.test(r.name) || names.has(r.name) || typeof r.job !== 'string' || /[\r\n\0]/u.test(r.job)) throw new AppError('bad_request');
    names.add(r.name); validateSlot(r.main); if (r.backup) validateSlot(r.backup);
    lines.push(`  ${JSON.stringify(r.name)}:`, `    main: ${encode(r.main)}`, ...(r.backup ? [`    backup: ${encode(r.backup)}`] : []), `    job: ${JSON.stringify(r.job)}`);
  }
  const text = await fs.readFile(file, 'utf8');
  const old = text.split('\n'); const start = old.findIndex(x => /^roles\s*:/u.test(x));
  let end = start + 1; while (end < old.length && !/^[^\s#][^:]*:/u.test(old[end] ?? '')) end++;
  const next = start < 0 ? `${text.trimEnd()}\n\n${lines.join('\n')}\n` : [...old.slice(0, start), ...lines, '', ...old.slice(end)].join('\n');
  await atomicWrite(file, next); return parseRoles(next);
}
export interface Launch { cli: string; model: string; effort: string }
export function resolveLaunch(roles: Roles, task: Pick<Task, 'role' | 'cli' | 'model' | 'effort'>, override: Partial<Launch>, initial: AiPick): Launch {
  const main = roles.roles[task.role]?.main;
  const cli = override.cli || task.cli || main?.cli || initial.ai;
  if (cli === HUMAN) throw new AppError('bad_request', 'no_cli_for_task');
  const model = override.model || (!task.cli || cli === task.cli ? task.model : '') || (cli === main?.cli ? main.model : '') || (cli === initial.ai ? initial.model : '');
  const effort = override.effort || task.effort || main?.effort || initial.effort;
  if (effort && !EFFORTS.includes(effort)) throw new AppError('bad_request', 'invalid_effort');
  return { cli, model: model === 'default' ? '' : model, effort };
}
