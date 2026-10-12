import type { GitPullRequestStatus } from './types.ts';
export interface GithubComment { id: string; author: string; body: string; url: string; state?: string }
export interface GithubReviewThread { id: string; resolved: boolean; path: string; line: number | null; comments: GithubComment[] }
export interface GithubPullRequest { number: number; title: string; url: string; state: string; mergeState: string; reviewDecision: string; checks: { name: string; status: string; conclusion: string }[]; reviews: GithubComment[]; comments: GithubComment[]; threads: GithubReviewThread[] }
export interface GithubReviewStatus extends GitPullRequestStatus { pr: GithubPullRequest | null }
export interface GithubIssue { number: number; title: string; body: string; url: string; state: string; contentVersion?: string }
export interface LinkedFeedback {
  revision: string; repository: string; kind: 'thread' | 'issue'; number: number; url: string;
  threadId: string; commentId: string; path: string; line: number | null; source: string; headOid: string;
  draft: string; resolved: boolean; state: string; contentVersion?: string;
}
export type GithubFeedbackInput =
  | { action: 'feedback-read'; repository: string; number: number; threadId: string; kind: 'thread' | 'issue' }
  | { action: 'feedback-write'; repository: string; number: number; threadId: string; commentId?: string; kind: 'thread' | 'issue'; operation: 'reply' | 'resolve' | 'unresolve' | 'update' | 'close'; body: string; title: string; headOid: string; expectedResolved: boolean; expectedState: string; expectedContentVersion?: string; confirmed: boolean };
export interface GithubFeedbackRemote { repository: string; issue?: GithubIssue; thread?: GithubReviewThread; url: string; headOid: string }
