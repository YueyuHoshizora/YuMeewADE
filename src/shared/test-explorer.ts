import type { VerifyResult, VerifyStatus } from './types.ts';

export interface VerificationHistoryEntry {
  id: string; at: string; before: string; after: string | null;
  configuration: string; result: VerifyResult; status: VerifyStatus;
  revoked?: boolean;
}
export interface TestRunnerConfiguration { name: string; files: string[]; }
export interface TestCaseNode {
  id: string; name: string; fullName: string; status: 'passed' | 'failed' | 'skipped' | 'todo' | 'unknown';
  children: TestCaseNode[]; error?: string; file?: string; line?: number;
}
export interface TestExplorerRun {
  id: string; at: string; runner: string; selection?: string; before: string; after: string | null;
  result: VerifyResult; tree: TestCaseNode[];
}
export interface TestExplorerState { revision: string; configurations: TestRunnerConfiguration[]; history: TestExplorerRun[]; }
