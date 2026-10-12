export interface ProposalEdit { id: string; from: number; to: number; text: string; state: 'pending' | 'accepted' | 'rejected' }
export interface ProposalFileInput { path: string; revision: string; text: string; selection: { from: number; to: number } }
export interface EditorProposalInput { files: ProposalFileInput[]; instruction: string; ai: string; model?: string; effort?: string }
export interface ProposalFile { path: string; revision: string; base: string; local: string; current: string; edits: ProposalEdit[] }
export interface EditorProposal { id: string; project: string; task: string; version: number; files: ProposalFile[]; ai: string; instruction: string; createdAt: string }
export interface ProposalSnapshot { path: string; revision: string; text: string }
export interface ProposalDecisionInput { version: number; accept: boolean; snapshots: ProposalSnapshot[]; target?: { path: string; edit: string } }
export interface ProposalDecision { proposal: EditorProposal; changes: Array<{ expected: ProposalSnapshot; edits: Array<{ from: number; to: number; text: string }> }> }
