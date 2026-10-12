interface TerminalKey { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; isComposing: boolean; getModifierState?(key: string): boolean }
const KEYS: Record<string, string> = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', Delete: '\x1b[3~', Insert: '\x1b[2~', Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~', F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~', F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~' };
const CURSOR: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
/** xterm-style keyboard subset; OS clipboard shortcuts and IME remain browser-owned. */
export function terminalKey(event: TerminalKey, applicationCursor: boolean): string | undefined {
  if (event.isComposing || event.metaKey || event.ctrlKey && event.shiftKey && ['c', 'v'].includes(event.key.toLowerCase())) return;
  // AltGr (reported as Ctrl+Alt on Windows) types characters such as @ [ ] { } on non-US layouts: let the input event send them.
  if (event.getModifierState?.('AltGraph') && [...event.key].length === 1) return;
  const modifier = 1 + Number(event.shiftKey) + 2 * Number(event.altKey) + 4 * Number(event.ctrlKey);
  const cursor = CURSOR[event.key];
  if (cursor) return modifier > 1 ? `\x1b[1;${modifier}${cursor}` : `\x1b${applicationCursor ? 'O' : '['}${cursor}`;
  if (event.key === 'Tab' && event.shiftKey) return '\x1b[Z';
  let value = KEYS[event.key];
  if (value && modifier > 1 && /\x1b\[\d+~$/u.test(value)) return value.replace('~', `;${modifier}~`);
  if (value && modifier > 1 && /^\x1bO[P-S]$/u.test(value)) return `\x1b[1;${modifier}${value.slice(-1)}`;
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) value = String.fromCharCode(code - 64);
    else if (event.key === ' ' || event.key === '2') value = '\0';
    else if (event.key === '3') value = '\x1b'; else if (event.key === '4') value = '\x1c'; else if (event.key === '5') value = '\x1d'; else if (event.key === '6') value = '\x1e'; else if (event.key === '7' || event.key === '-') value = '\x1f'; else if (event.key === '8' || event.key === '?') value = '\x7f';
  }
  if (event.altKey) { if (value !== undefined) return '\x1b' + value; if (event.key.length === 1) return '\x1b' + event.key; }
  return value;
}

export function terminalPaste(text: string, bracketed: boolean): string {
  // A pasted closing delimiter must not escape bracketed-paste mode into shell commands.
  const normalized = text.replace(/\r\n|\n/gu, '\r');
  return bracketed ? `\x1b[200~${normalized.replace(/\x1b/gu, '')}\x1b[201~` : normalized;
}
