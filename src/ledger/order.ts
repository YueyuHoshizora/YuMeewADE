import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { readJson, updateJson } from '../shared/fsx.ts';
import { isValidProjectName } from '../shared/names.ts';
import type { Workspace } from './workspace.ts';

export interface OrderData { order: Record<string, string[]>; pins: string[] }
export class OrderStore {
  readonly file: string;
  constructor(ws: Workspace) { this.file = path.join(ws.internalDir, 'order.json'); }
  /** Valid JSON of the wrong shape names the file instead of failing later as an anonymous TypeError. */
  private checked(value: Partial<OrderData>): OrderData {
    const order = value.order ?? {}; const pins = value.pins ?? [];
    const strings = (list: unknown): boolean => Array.isArray(list) && list.every(id => typeof id === 'string');
    if (!order || typeof order !== 'object' || Array.isArray(order) || !Object.values(order).every(strings) || !strings(pins)) throw new AppError('internal', 'file_corrupt', { field: path.basename(this.file) });
    return { order, pins };
  }
  async get(): Promise<OrderData> {
    return this.checked(await readJson<Partial<OrderData>>(this.file, {}));
  }
  async setOrder(parent: string, order: string[]): Promise<string[]> {
    if (typeof parent !== 'string' || parent && !isValidProjectName(parent) || !Array.isArray(order) || order.some(id => !isValidProjectName(id))) throw new AppError('bad_request', 'field_type');
    const value = await updateJson<OrderData>(this.file, { order: {}, pins: [] }, data => {
      Object.assign(data, this.checked(data));
      data.order[parent] = [...new Set(order)];
    });
    return value.order[parent]!;
  }
  async setPinned(project: string, pinned: boolean): Promise<string[]> {
    if (!isValidProjectName(project) || typeof pinned !== 'boolean') throw new AppError('bad_request', 'field_type');
    const value = await updateJson<OrderData>(this.file, { order: {}, pins: [] }, data => {
      Object.assign(data, this.checked(data));
      data.pins = data.pins.filter(id => id !== project);
      if (pinned) data.pins.push(project);
    });
    return value.pins;
  }
}
