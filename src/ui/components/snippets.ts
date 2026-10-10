/** 常用指示的純函式（不碰 DOM／localStorage，方便測試）。 */
export interface Snippet {
  name: string;
  text: string;
}

export const SNIPPET_LIMIT = 30;

export function addSnippet(list: Snippet[], name: string, text: string): Snippet[] {
  const label = name.trim().slice(0, 40);
  const body = text.trim();
  if (!label || !body) return list;
  return [...list.filter(s => s.name !== label), { name: label, text: body }].slice(-SNIPPET_LIMIT);
}

export function removeSnippet(list: Snippet[], name: string): Snippet[] {
  return list.filter(s => s.name !== name);
}

/** 草稿已有內容就空一行接在後面，不覆蓋。 */
export function insertSnippet(draft: string, text: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n${text}` : text;
}

/** localStorage 裡讀回來的值不可信：只留結構正確的項目。 */
export function sanitizeSnippets(stored: unknown): Snippet[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || !('text' in entry)) return [];
    return typeof entry.name === 'string' && typeof entry.text === 'string' ? [{ name: entry.name, text: entry.text }] : [];
  }).slice(0, SNIPPET_LIMIT);
}
