export interface WorkbenchLayout { width: number; tree: number; dock: 'right' | 'bottom'; }
export const defaultLayout: WorkbenchLayout = { width: 50, tree: 22, dock: 'right' };
export function normalizeLayout(value: unknown): WorkbenchLayout {
  const v = value && typeof value === 'object' ? value as Partial<WorkbenchLayout> : {};
  const clamp = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? Math.max(20, Math.min(80, n)) : fallback;
  return { width: clamp(v.width, 50), tree: clamp(v.tree, 22), dock: v.dock === 'bottom' ? 'bottom' : 'right' };
}
export function fileHierarchy(paths: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) { const at = path.lastIndexOf('/'); const folder = at < 0 ? '' : path.slice(0, at); const entries = groups.get(folder) ?? []; entries.push(path); groups.set(folder, entries); }
  return groups;
}
export function pendingProposalRanges(edits: { from: number; to: number; state: string; text?: string }[]): { from: number; to: number }[] {
  const accepted = edits.filter(edit => edit.state === 'accepted' && typeof edit.text === 'string');
  return edits.filter(edit => edit.state === 'pending').map(edit => {
    let shift = 0;
    for (const previous of accepted) if (previous.to <= edit.from) shift += previous.text!.length - (previous.to - previous.from);
    return { from: edit.from + shift, to: edit.to + shift };
  });
}
