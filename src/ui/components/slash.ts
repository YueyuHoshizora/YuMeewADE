export interface SlashToken { query: string; end: number }

/** Completion only applies to the command name at the very beginning of the draft. */
export function slashAt(text: string, caret: number): SlashToken | null {
  if (!text.startsWith('/') || caret < 1 || caret > text.length) return null;
  const end = text.search(/\s/);
  const tokenEnd = end < 0 ? text.length : end;
  if (caret > tokenEnd || text.slice(1, tokenEnd).includes('/')) return null;
  return { query: text.slice(1, caret), end: tokenEnd };
}

export function applySlash(text: string, token: SlashToken, name: string): { text: string; caret: number } {
  const insert = `/${name} `;
  // Keep arguments and @mentions, avoiding a second separator when arguments already exist.
  const suffix = text.slice(token.end);
  return { text: insert + (suffix.startsWith(' ') ? suffix.slice(1) : suffix), caret: insert.length };
}
