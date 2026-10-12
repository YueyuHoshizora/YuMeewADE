import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, updateJson } from '../shared/fsx.ts';
import type { Step, Task } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';

interface CompletionData { approved: Record<string, string>; continued: Record<string, string>; phaseContinued: Record<string, string> }
export function stepsHash(steps: Step[]): string { return createHash('sha256').update(JSON.stringify(steps)).digest('hex'); }
export function phaseKey(tasks: Task[]): string {
  return createHash('sha256').update(JSON.stringify(tasks.map(t => [t.id, t.state]).sort((a,b) => a[0]!.localeCompare(b[0]!)))).digest('hex');
}
/** Keys are project names, and `__proto__` is a valid one: plain objects would turn its assignment into a prototype change. */
const dict = (value: Record<string, string> | undefined): Record<string, string> => Object.assign(Object.create(null) as Record<string, string>, value);
export class CompletionStore {
  private readonly file: string;
  constructor(ws: Workspace) { this.file = path.join(ws.internalDir, 'completion.json'); }
  private async data(): Promise<CompletionData> {
    const value = await readJson<Partial<CompletionData>>(this.file, {});
    return { approved: dict(value.approved), continued: dict(value.continued), phaseContinued: dict(value.phaseContinued) };
  }
  private async change(fn: (data: CompletionData) => void): Promise<void> {
    await updateJson<CompletionData>(this.file, { approved: {}, continued: {}, phaseContinued: {} }, data => {
      data.approved = dict(data.approved); data.continued = dict(data.continued); data.phaseContinued = dict(data.phaseContinued); fn(data);
    });
  }
  async isApproved(p: string, t: string): Promise<boolean> { return !!(await this.data()).approved[`${p}/${t}`]; }
  async approve(p: string, t: string): Promise<void> { await this.change(d => { d.approved[`${p}/${t}`] = new Date().toISOString(); }); }
  async revoke(p: string, t: string): Promise<void> { await this.change(d => { delete d.approved[`${p}/${t}`]; }); }
  async continued(p: string, t: string): Promise<string | undefined> { return (await this.data()).continued[`${p}/${t}`]; }
  async setContinued(p: string, t: string, hash: string): Promise<void> { await this.change(d => { d.continued[`${p}/${t}`] = hash; }); }
  async phaseContinued(p: string): Promise<string | undefined> { return (await this.data()).phaseContinued[p]; }
  async setPhaseContinued(p: string, key: string): Promise<void> { await this.change(d => { d.phaseContinued[p] = key; }); }
}
