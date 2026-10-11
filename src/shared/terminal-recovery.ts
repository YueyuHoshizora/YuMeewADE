import type { TerminalLease } from './execution-tools.ts';

export interface TerminalRecoveryTab { id: string; project: string; task: string; label: string; sequence: number; status: 'running' | 'exited' | 'stopped' }
export interface TerminalRecoveryLease extends TerminalLease { ticket: string }
export interface TerminalRecoveryList { generation: string; tabs: TerminalRecoveryTab[] }
