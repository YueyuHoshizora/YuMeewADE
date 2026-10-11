import type { GitPullRequestStatus } from './types.ts';
export interface GithubComment { author: string; body: string; url: string; state?: string }
export interface GithubPullRequest { number: number; title: string; url: string; state: string; mergeState: string; reviewDecision: string; checks: { name: string; status: string; conclusion: string }[]; reviews: GithubComment[]; comments: GithubComment[]; threads: { resolved: boolean; path: string; line: number | null; comments: GithubComment[] }[] }
export interface GithubReviewStatus extends GitPullRequestStatus { pr: GithubPullRequest | null }
export interface GithubIssue { number: number; title: string; body: string; url: string }
