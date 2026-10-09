// roles.yaml 讀取與 role→啟動參數解析（PLAN.md A.4）。
// 槽位 [cli, model, effort]；`人` 代表不由 AI 執行。危險旗標不在這裡，只看 config.yaml。

import { promises as fs } from 'node:fs';
import { AppError } from '../shared/errors.ts';
import { EFFORTS, type RoleDef, type RoleSlot, type Roles, type Task } from '../shared/types.ts';
import { parseYamlMap, YamlError, type YamlValue } from '../shared/yaml.ts';

export const HUMAN = '人';

function slot(v: YamlValue | undefined, where: string): RoleSlot | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
    throw new YamlError(`${where} 必須是 [cli, model, effort]`, 0);
  }
  const list = v as string[];
  return { cli: list[0] ?? '', model: list[1] ?? 'default', effort: list[2] ?? '' };
}

export function parseRoles(text: string): Roles {
  const map = parseYamlMap(text);
  const models: Record<string, string[]> = {};
  const rawModels = map['models'];
  if (rawModels && typeof rawModels === 'object' && !Array.isArray(rawModels)) {
    for (const [cli, list] of Object.entries(rawModels)) {
      models[cli] = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    }
  }
  const roles: Record<string, RoleDef> = {};
  const rawRoles = map['roles'];
  if (rawRoles && typeof rawRoles === 'object' && !Array.isArray(rawRoles)) {
    for (const [name, def] of Object.entries(rawRoles)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw new YamlError(`roles.${name} 必須是 map`, 0);
      const main = slot(def['main'], `roles.${name}.main`);
      if (!main) throw new YamlError(`roles.${name}.main 必填`, 0);
      const backup = slot(def['backup'], `roles.${name}.backup`);
      roles[name] = { main, ...(backup ? { backup } : {}), job: def['job'] === null || def['job'] === undefined ? '' : String(def['job']) };
    }
  }
  return { models, roles };
}

export async function loadRoles(file: string): Promise<Roles> {
  return parseRoles(await fs.readFile(file, 'utf8'));
}

export interface Launch {
  cli: string;
  model: string;
  effort: string;
}

/**
 * 啟動參數優先序：單次送出覆寫 > 作業檔 cli/model/effort > role 的 main。
 * model 為 default／空 → 交給 CLI 預設；effort 若不在允許值內 → 丟 400。
 */
export function resolveLaunch(roles: Roles, task: Pick<Task, 'role' | 'cli' | 'model' | 'effort'>, override: Partial<Launch>): Launch {
  const role = task.role ? roles.roles[task.role] : undefined;
  const main = role?.main;
  const cli = override.cli || task.cli || main?.cli || '';
  if (!cli || cli === HUMAN) throw new AppError('bad_request', '此作業未指定可執行的 CLI（role 為人或未設定）');
  // 換了 CLI 就不能沿用別的 CLI 的模型
  const sameCliAsTask = !override.cli || override.cli === task.cli;
  const sameCliAsRole = cli === main?.cli;
  let model = override.model || (sameCliAsTask ? task.model : '') || (sameCliAsRole ? main?.model : '') || '';
  if (model === 'default') model = '';
  const effort = override.effort || task.effort || main?.effort || '';
  if (effort && !EFFORTS.includes(effort as (typeof EFFORTS)[number])) throw new AppError('bad_request', 'effort 不合法');
  return { cli, model, effort };
}
