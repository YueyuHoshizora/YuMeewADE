import { AppError } from './errors.ts';

/** Reserve before any await: snapshots cannot race an already admitted mutation. */
export class MutationGate {
  private active = 0;
  private reserved = false;

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.reserved) throw new AppError('conflict', 'care_busy');
    this.active++;
    try { return await work(); }
    finally { this.active--; }
  }

  async exclusive<T>(isBusy: () => boolean, work: () => Promise<T>): Promise<T> {
    if (this.reserved || this.active || isBusy()) throw new AppError('conflict', 'care_busy');
    this.reserved = true;
    try { return await work(); }
    finally { this.reserved = false; }
  }

  get busy(): boolean { return this.reserved; }
}
