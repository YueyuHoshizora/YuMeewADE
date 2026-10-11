export type ReviewFindingState = 'open' | 'resolved' | 'dismissed';
export interface ReviewFinding {
  id: string; severity: 'critical' | 'major' | 'minor' | 'info';
  path: string; line: number; endLine?: number; message: string; evidence: string;
  state: ReviewFindingState; transitions: { state: ReviewFindingState; evidence: string; at: string }[];
}
export interface ReviewSnapshot {
  id: string; request: string; at: string; ai: string; revision: string; content: string;
  text: string; ok: boolean; approved: boolean; structured: boolean; findings: ReviewFinding[];
}
export interface ReviewHistory { snapshots: ReviewSnapshot[]; requireApproval: boolean; stale: boolean }
