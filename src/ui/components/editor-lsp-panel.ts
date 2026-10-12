import type { EditorSettings } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, card, el, field, input, run, select, UserError, type ViewContext } from './dom.ts';
export function editorLspPanel(context: ViewContext): HTMLElement {
  const project = select(context.state.projects.map(p => ({value:p.id,label:p.name})), context.state.projects[0]?.id ?? '');
  const commands = area(); commands.spellcheck = false; const status = el('div'); let settings: EditorSettings | undefined; let serial = 0;
  const tabSize = input('4'); tabSize.type = 'number'; tabSize.min = '1'; tabSize.max = '16';
  const spaces = input(); spaces.type = 'checkbox';
  const eol = select([{value:'preserve',label:t('editorUI.preserve')},{value:'lf',label:'LF'},{value:'crlf',label:'CRLF'}], 'preserve');
  async function load(): Promise<void> {
    const token = ++serial; const id = project.value; settings = undefined; commands.disabled = true;
    if (!id) { status.replaceChildren(el('p','muted',t('common.empty'))); return; }
    const next = await request<EditorSettings>(query('/api/editor/settings',{project:id}));
    if (token !== serial || id !== project.value) return;
    settings = next; commands.value = JSON.stringify(next.commands,null,2); commands.disabled = false;
    tabSize.value = String(next.format.tabSize); spaces.checked = next.format.insertSpaces; eol.value = next.format.eol;
    status.replaceChildren(...next.diagnostics.map(entry => el('p','muted',`${entry.language}: ${t(`editorUI.${entry.state}`)} · ${entry.capabilities.join(', ') || '—'}`)));
  }
  project.onchange = () => { void run(load); };
  const panel = card(t('editorUI.lsp'),project,field(t('editorUI.commands'),commands),el('h3','',t('editorUI.format')),field(t('editorUI.tabSize'),tabSize),field(t('editorUI.spaces'),spaces),field(t('editorUI.eol'),eol),button(t('common.save'),async () => {
    if (!settings) return; let parsed: unknown;
    try { parsed = JSON.parse(commands.value); } catch { throw new UserError(t('editorUI.invalid')); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(v => !Array.isArray(v) || !v.every(arg => typeof arg === 'string'))) throw new UserError(t('editorUI.invalid'));
    await request('/api/editor/settings',{project:project.value,revision:settings.revision,commands:parsed,format:{tabSize:Number(tabSize.value),insertSpaces:spaces.checked,eol:eol.value}}); await load();
  }),button(t('common.refresh'),load),status);
  void run(load); return panel;
}
