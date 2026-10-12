import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export interface Bounds { x: number; y: number; width: number; height: number }
export interface WindowState { bounds: Bounds; maximized: boolean; fullscreen: boolean }
export function restoreState(value: unknown, displays: readonly Bounds[]): WindowState {
  const primary = displays[0] ?? { x: 0, y: 0, width: 1280, height: 820 };
  const raw = value as Partial<WindowState> | null;
  const b = raw?.bounds;
  const valid = b && [b.x, b.y, b.width, b.height].every(Number.isSafeInteger) && b.width >= 640 && b.height >= 480 && b.width <= 16384 && b.height <= 16384;
  // Visible when the work areas (which never overlap) together cover the whole window, also across adjacent monitors.
  const covered = (box: Bounds) => displays.reduce((area, d) => area + Math.max(0, Math.min(box.x + box.width, d.x + d.width) - Math.max(box.x, d.x)) * Math.max(0, Math.min(box.y + box.height, d.y + d.height) - Math.max(box.y, d.y)), 0) >= box.width * box.height;
  const visible = valid && covered(b);
  const width = Math.min(valid ? b.width : 1280, primary.width);
  const height = Math.min(valid ? b.height : 820, primary.height);
  return { bounds: visible && b ? { ...b } : { x: Math.round(primary.x + (primary.width - width) / 2), y: Math.round(primary.y + (primary.height - height) / 2), width, height }, maximized: raw?.maximized === true, fullscreen: raw?.fullscreen === true };
}
export class WindowStateStore {
  private states: unknown[] = [];
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    try { const parsed: unknown = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(parsed)) this.states = parsed.slice(0, 32); } catch { /* Missing or invalid state uses centered defaults. */ }
  }
  get(slot: number, displays: readonly Bounds[]): WindowState { return restoreState(this.states[slot], displays); }
  save(slot: number, state: WindowState): void {
    this.states[slot] = state;
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.states), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
