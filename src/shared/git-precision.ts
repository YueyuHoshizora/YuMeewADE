export interface GitDiffLine { id: number; kind: 'add' | 'remove' | 'context'; text: string; noNewline?: boolean }
export interface GitDiffHunk { id: number; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: GitDiffLine[] }
export interface GitFileDiff { path: string; staged: boolean; fingerprint: string; patch: string; hunks: GitDiffHunk[]; selectable: boolean }
export interface GitConflictView { path: string; base: string | null; ours: string | null; theirs: string | null }
/** `truncated`: more files differ than are listed (at most 100 files or 2 MiB of patches). */
export interface TaskComparison { leftTask: string; rightTask: string; leftBranch: string; rightBranch: string; files: { path: string; patch: string }[]; truncated?: boolean }
