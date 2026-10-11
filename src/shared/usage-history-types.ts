import type { TurnUsage } from './types.ts';

export type BudgetUnit = 'tokens' | 'codexCredits' | 'claudeUsd';
export interface UsageScope { project: string; task: string; ai: string; account: string }
export interface ReportedUsageRecord extends UsageScope {
  requestId: string;
  sessionId?: string;
  at: string;
  usage: TurnUsage | null;
  codexCredits?: number;
  claudeUsd?: number;
  provenance: 'provider-reported';
}
export interface BudgetRule {
  id: string;
  project?: string;
  task?: string;
  ai?: string;
  account?: string;
  unit: BudgetUnit;
  threshold: number;
  since: string;
}
export interface BudgetSettings { rules: BudgetRule[]; quotaRemainingPercent: number | null; cloudExpiryHours: number | null }
export interface UsageTotals extends UsageScope {
  input: number; output: number; cached: number;
  tokenReports: number; cachedReports: number; unknownReports: number;
  codexCredits: number; codexCreditReports: number;
  claudeUsd: number; claudeUsdReports: number;
  requests: number;
}
export interface UsageHistoryView { records: ReportedUsageRecord[]; totals: UsageTotals[]; settings: BudgetSettings; hasMore: boolean }
export interface BudgetWarning { kind: 'threshold' | 'quota' | 'cloudExpiry'; ruleId?: string; unit?: BudgetUnit; reported?: number; threshold?: number; at?: string }
export interface BudgetCheck { scope: UsageScope; warnings: BudgetWarning[]; acknowledgment: string | null; unknown: boolean }
