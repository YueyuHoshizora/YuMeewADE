import type { GitDiffHunk } from '../shared/git-precision.ts';
import { AppError } from '../shared/errors.ts';

export function parseHunks(patch: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = []; let lineId = 0;
  for (const line of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) hunks.push({ id: hunks.length, oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: [] });
    else if (hunks.length && /^[ +\-]/.test(line)) hunks.at(-1)!.lines.push({ id: lineId++, kind: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context', text: line.slice(1) });
    else if (line === '\\ No newline at end of file') {
      const previous = hunks.at(-1)?.lines.at(-1);
      if (previous) previous.noNewline = true;
    }
  }
  return hunks;
}

/** Rebuild a patch only from server-generated changed lines. No client patch or path is executed. */
export function selectedPatch(patch: string, selected: number[]): string {
  const hunks = parseHunks(patch); const ids = new Set(selected);
  // One pass builds the selectable ids, so validating a large selection stays linear in the diff size.
  const changed = new Set(hunks.flatMap(h => h.lines.filter(l => l.kind !== 'context').map(l => l.id)));
  if (!ids.size || ids.size !== selected.length || selected.some(id => !Number.isSafeInteger(id) || !changed.has(id))) throw new AppError('bad_request', 'git_workbench_path');
  let header = patch.slice(0, patch.indexOf('@@ '));
  if (!header || /(?:rename from|rename to|Binary files|GIT binary patch)/.test(header)) throw new AppError('conflict', 'git_workbench_path');
  // Only the chosen text lines are applied; an executable-bit change in the same diff is not one of them.
  header = header.replace(/^(?:old|new) mode .+\n/gmu, '');
  if (header.includes('deleted file mode') && ids.size !== hunks.reduce((count, h) => count + h.lines.filter(l => l.kind !== 'context').length, 0)) {
    const oldPath = /^--- (.+)$/m.exec(header)?.[1];
    if (!oldPath) throw new AppError('conflict', 'git_workbench_path');
    const newPath = oldPath.startsWith('"a/') ? `"b/${oldPath.slice(3)}` : oldPath.replace(/^a\//, 'b/');
    header = header.replace(/^deleted file mode .+\n/m, '').replace(/^\+\+\+ \/dev\/null$/m, `+++ ${newPath}`);
  }
  const output = [header.trimEnd()]; let delta = 0;
  for (const hunk of hunks) {
    const lines: string[] = []; let oldCount = 0; let newCount = 0; let changes = 0;
    const emit = (line: GitDiffHunk['lines'][number]) => {
      if (line.kind === 'add') { if (!ids.has(line.id)) return; lines.push(`+${line.text}`); newCount++; changes++; }
      else if (line.kind === 'remove' && ids.has(line.id)) { lines.push(`-${line.text}`); oldCount++; changes++; }
      else { lines.push(` ${line.text}`); oldCount++; newCount++; }
      if (line.noNewline) lines.push('\\ No newline at end of file');
    };
    for (let index = 0; index < hunk.lines.length;) {
      if (hunk.lines[index]!.kind === 'context') { emit(hunk.lines[index++]!); continue; }
      const start = index; let lastRemoval = -1;
      while (index < hunk.lines.length && hunk.lines[index]!.kind !== 'context') {
        const line = hunk.lines[index]!;
        if (line.kind === 'remove' && ids.has(line.id)) lastRemoval = index;
        index++;
      }
      // Insert selected replacements before the preserved old lines that follow them, not at the block's end.
      const additions = () => {
        for (let cursor = start; cursor < index; cursor++) if (hunk.lines[cursor]!.kind === 'add') emit(hunk.lines[cursor]!);
      };
      for (let cursor = start; cursor < index; cursor++) {
        if (hunk.lines[cursor]!.kind === 'remove') emit(hunk.lines[cursor]!);
        if (cursor === lastRemoval) additions();
      }
      if (lastRemoval < 0) additions();
    }
    if (!changes) continue;
    const oldStart = hunk.oldStart;
    const newStart = oldCount === 0 ? oldStart + delta + 1 : newCount === 0 ? oldStart + delta - 1 : oldStart + delta;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines);
    delta += newCount - oldCount;
  }
  return output.join('\n') + '\n';
}
