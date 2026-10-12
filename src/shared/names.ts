// 專案名／作業 ID 白名單。任何來自請求的名稱都要先經過這裡才能拼進路徑。

// Microsoft's naming rules also reserve COM0／LPT0 and the superscript-digit forms (COM¹…LPT³), which \p{N} would admit.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const PROJECT_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,63}$/u;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidProjectName(name: unknown): name is string {
  if (typeof name !== 'string' || !PROJECT_RE.test(name)) return false;
  if (name.includes('..') || name.endsWith('.') || name.endsWith(' ')) return false;
  // `CON .txt` is still the device: Windows ignores the spaces before the extension.
  if (WINDOWS_RESERVED.test((name.split('.')[0] ?? '').trimEnd())) return false;
  return true;
}

export function isValidTaskId(id: unknown): id is string {
  return typeof id === 'string' && TASK_RE.test(id) && !WINDOWS_RESERVED.test(id);
}

/** 以 `YYYYMMDD-NNN` 產生當日下一個作業 ID；existing 為既有 ID 清單。 */
export function nextTaskId(existing: Iterable<string>, now = new Date()): string {
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  let max = 0;
  for (const id of existing) {
    const m = new RegExp(`^${day}-(\\d{3,})$`).exec(id);
    if (m && m[1] !== undefined) max = Math.max(max, Number(m[1]));
  }
  return `${day}-${String(max + 1).padStart(3, '0')}`;
}
