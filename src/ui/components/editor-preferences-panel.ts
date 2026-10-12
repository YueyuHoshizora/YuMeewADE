import { t } from '../i18n/index.ts';
import { button, card, field, input, select, toast, UserError } from './dom.ts';
import { defaultPreferences, readPreferences, savePreferences } from './editor-preferences.ts';
export function editorPreferencesPanel(): HTMLElement {
  const prefs = readPreferences(); const font = input(prefs.fontFamily); const size = input(String(prefs.fontSize)); size.type = 'number'; size.min = '8'; size.max = '40';
  const tabs = input(String(prefs.tabSize)); tabs.type = 'number'; tabs.min = '1'; tabs.max = '8';
  const spaces = input(); spaces.type = 'checkbox'; spaces.checked = prefs.insertSpaces;
  const wrap = input(); wrap.type = 'checkbox'; wrap.checked = prefs.wrap;
  const eol = select(['preserve','lf','crlf'].map(value => ({value,label:value})),prefs.eol);
  const save = input(prefs.keys.save); const selection = input(prefs.keys.selection);
  return card(t('editorUI.preferences'), field(t('editorUI.font'),font),field(t('editorUI.fontSize'),size),field(t('editorUI.tabSize'),tabs),field(t('editorUI.spaces'),spaces),field(t('editorUI.wrap'),wrap),field(t('editorUI.eol'),eol),field(`${t('editorUI.keys')} · ${t('common.save')}`,save),field(`${t('editorUI.keys')} · ${t('editorEvents.send')}`,selection),button(t('common.save'),() => {
    try { savePreferences({fontFamily:font.value,fontSize:Number(size.value),tabSize:Number(tabs.value),insertSpaces:spaces.checked,wrap:wrap.checked,eol:eol.value,keys:{save:save.value,selection:selection.value}}); toast(t('common.saved')); } catch { throw new UserError(t('editorUI.invalid')); }
  }),button(t('editorUI.reset'),() => { savePreferences(defaultPreferences); font.value=defaultPreferences.fontFamily;size.value=String(defaultPreferences.fontSize);tabs.value=String(defaultPreferences.tabSize);spaces.checked=defaultPreferences.insertSpaces;wrap.checked=defaultPreferences.wrap;eol.value=defaultPreferences.eol;save.value=defaultPreferences.keys.save;selection.value=defaultPreferences.keys.selection; }));
}
