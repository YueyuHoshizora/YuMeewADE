import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { readJson, updateJson } from '../shared/fsx.ts';
import { isValidProjectName } from '../shared/names.ts';
import type { Workspace } from './workspace.ts';

export interface OrderData { order: Record<string, string[]>; pins: string[] }
export class OrderStore {
  private readonly file: string;
  constructor(ws: Workspace) { this.file = path.join(ws.internalDir, 'order.json'); }
  async get(): Promise<OrderData> {
    const value = await readJson<Partial<OrderData>>(this.file, {});
    return { order: value.order ?? {}, pins: value.pins ?? [] };
  }
  async setOrder(parent: string, order: string[]): Promise<string[]> {
    if (typeof parent !== 'string' || parent && !isValidProjectName(parent) || !Array.isArray(order) || order.some(id => !isValidProjectName(id))) throw new AppError('bad_request', 'field_type');
    const value = await updateJson<OrderData>(this.file, { order: {}, pins: [] }, data => {
      data.order ??= {}; data.pins ??= [];
      data.order[parent] = [...new Set(order)];
    });
    return value.order[parent]!;
  }
  async setPinned(project: string, pinned: boolean): Promise<string[]> {
    if (!isValidProjectName(project) || typeof pinned !== 'boolean') throw new AppError('bad_request', 'field_type');
    const value = await updateJson<OrderData>(this.file, { order: {}, pins: [] }, data => {
      data.order ??= {}; data.pins ??= [];
      data.pins = data.pins.filter(id => id !== project);
      if (pinned) data.pins.push(project);
    });
    return value.pins;
  }
}
