export interface EditorPreferences { fontFamily: string; fontSize: number; tabSize: number; insertSpaces: boolean; wrap: boolean; eol: 'preserve' | 'lf' | 'crlf'; keys: { save: string; selection: string }; }
export const defaultPreferences: EditorPreferences = { fontFamily: 'ui-monospace, monospace', fontSize: 14, tabSize: 2, insertSpaces: true, wrap: false, eol: 'preserve', keys: { save: 'Mod-s', selection: 'Mod-Shift-l' } };
export function validatePreferences(value: unknown): EditorPreferences {
  if (!value || typeof value !== 'object') throw new Error('Invalid preferences');
  const v = value as EditorPreferences;
  if (typeof v.fontFamily !== 'string' || !/^[a-zA-Z0-9 ,_\-]{1,120}$/.test(v.fontFamily) || !Number.isInteger(v.fontSize) || v.fontSize < 8 || v.fontSize > 40 || !Number.isInteger(v.tabSize) || v.tabSize < 1 || v.tabSize > 8 || typeof v.insertSpaces !== 'boolean' || typeof v.wrap !== 'boolean' || !['preserve','lf','crlf'].includes(v.eol)) throw new Error('Invalid preferences');
  if (!v.keys || typeof v.keys.save !== 'string' || typeof v.keys.selection !== 'string') throw new Error('Invalid keybindings');
  const reserved = ['Mod-k', 'Mod-p', 'Mod-Shift-p', 'Mod-Shift-f', 'Mod-c', 'Mod-v', 'Mod-x', 'Mod-z', 'Mod-a', 'Mod-f', 'Mod-Shift-z', 'Mod-y', 'Mod-r', 'Mod-w', 'Mod-t', 'Mod-n', 'Mod-q'];
  for (const key of Object.values(v.keys)) if (!/^Mod-(Shift-)?[a-z]$/.test(key) || reserved.includes(key)) throw new Error('Invalid keybindings');
  if (v.keys.save === v.keys.selection) throw new Error('Conflicting keybindings');
  return { fontFamily: v.fontFamily, fontSize: v.fontSize, tabSize: v.tabSize, insertSpaces: v.insertSpaces, wrap: v.wrap, eol: v.eol, keys: { ...v.keys } };
}
export function readPreferences(): EditorPreferences {
  try { return validatePreferences(JSON.parse(localStorage.getItem('yumeewade.editor.preferences') ?? 'null')); } catch { return { ...defaultPreferences, keys: { ...defaultPreferences.keys } }; }
}
export function savePreferences(value: unknown): void {
  const prefs = validatePreferences(value); localStorage.setItem('yumeewade.editor.preferences', JSON.stringify(prefs)); window.dispatchEvent(new Event('yumeewade:editor-preferences'));
}
export function preferenceCommand(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, prefs: EditorPreferences): 'save' | 'selection' | undefined {
  if (event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  const key = `Mod-${event.shiftKey ? 'Shift-' : ''}${event.key.toLowerCase()}`;
  if (key === prefs.keys.save) return 'save'; if (key === prefs.keys.selection) return 'selection';
}
export function serializeEol(text: string, eol: EditorPreferences['eol'], base: string): string {
  const ending = eol === 'preserve' ? base.includes('\r\n') ? '\r\n' : '\n' : eol === 'crlf' ? '\r\n' : '\n';
  return text.replace(/\r\n|\r|\n/g, ending);
}
