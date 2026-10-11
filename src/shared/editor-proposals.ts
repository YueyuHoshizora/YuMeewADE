export interface ProposalEdit { id: string; from: number; to: number; text: string; state: 'pending' | 'accepted' | 'rejected' }
export interface EditorProposalInput { path: string; revision: string; text: string; selection: { from: number; to: number }; instruction: string; ai: string; model?: string; effort?: string }
export interface EditorProposal { id: string; project: string; task: string; path: string; revision: string; version: number; base: string; local: string; current: string; ai: string; instruction: string; createdAt: string; edits: ProposalEdit[] }
export interface ProposalDecision { proposal: EditorProposal; edits: Array<{ from: number; to: number; text: string }>; expected: { path: string; revision: string; text: string } }
