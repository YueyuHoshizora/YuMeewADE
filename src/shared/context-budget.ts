export interface PinnedSource { path: string; start: number; end: number; priority?: number; order?: number; enabled?: boolean; allocatedChars?: number }
export interface TaskContext { decisions: string; sources: PinnedSource[]; decisionBudget?: number; revision?: number }
export type ContextSourceStatus = 'included' | 'truncated' | 'unavailable' | 'disabled';
export interface ContextAllocation { id: string; status: ContextSourceStatus; allocatedChars: number; sentChars: number; availableChars?: number; providerTokens?: number }
export interface BuiltTaskContext { text: string; truncated: boolean; sources: PinnedSource[]; allocations: ContextAllocation[]; budgetChars: number; revision: number }
export interface ContextManifest { request: string; ai: string; model?: string; at: string; context: BuiltTaskContext; handoff: { text: string; rows: number[]; start: number | null; end: number | null; truncated: boolean }; providerTokens?: number }

/** Keep complete line boundaries; no tokenizer assumptions or partial authorization fences. */
export function fitContextSection(text: string, budget: number): string {
  if (text.length <= budget) return text;
  let end = 0; let lines = 0;
  for (const line of text.split('\n')) {
    const next = end + line.length + (lines ? 1 : 0);
    if (next > budget) break;
    end = next; lines++;
  }
  return text.slice(0, end);
}
