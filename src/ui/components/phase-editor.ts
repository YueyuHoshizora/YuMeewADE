import { PHASES_MAX, type ProjectView } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, disclosure, el, input, setLocked, toast } from './dom.ts';

/** `from` is the existing phase a row continues (its state and tasks follow a rename); new rows have none. */
interface PhaseRow { name: string; from?: string }
interface Draft { base: string[]; rows: PhaseRow[] }

// The project overview is rebuilt on every state change; unsaved edits live here so a background update does not wipe them.
const drafts = new Map<string, Draft>();

export function phaseEditor(project: ProjectView, refresh: () => Promise<void>): HTMLDetailsElement {
  const names = project.phases.map(phase => phase.name);
  const states = new Map(project.phases.map(phase => [phase.name, phase.state]));
  const fresh = (): Draft => ({ base: names, rows: names.map(name => ({ name, from: name })) });
  let draft = drafts.get(project.id) ?? fresh();
  const touch = () => { drafts.set(project.id, draft); };
  const list = el('ol', 'phase-editor-list');
  const stale = el('p', 'warning', t('phases.stale'));
  function render(): void {
    stale.hidden = JSON.stringify(draft.base) === JSON.stringify(names);
    setLocked(add, draft.rows.length >= PHASES_MAX);
    list.replaceChildren(...draft.rows.map((entry, index) => {
      const item = el('li');
      const name = input(entry.name, t('phases.name')); name.setAttribute('aria-label', t('phases.name')); name.maxLength = 200;
      name.oninput = () => { entry.name = name.value; touch(); };
      const move = (step: number) => { const [moved] = draft.rows.splice(index, 1); draft.rows.splice(index + step, 0, moved!); touch(); render(); };
      const up = button(t('tree.up'), () => move(-1)); up.disabled = index === 0;
      const down = button(t('tree.down'), () => move(1)); down.disabled = index === draft.rows.length - 1;
      item.append(name, up, down, button(t('common.remove'), () => { draft.rows.splice(index, 1); touch(); render(); }));
      if (entry.from !== undefined && states.get(entry.from) === '完成') item.append(el('span', 'state-chip', t('state.完成')));
      return item;
    }));
  }
  const add = button(t('phases.add'), () => {
    draft.rows.push({ name: '' }); touch(); render();
    list.querySelector<HTMLInputElement>('li:last-child input')?.focus();
  });
  const save = button(t('common.save'), async () => {
    await request('/api/project/phases', { project: project.id, previous: draft.base, phases: draft.rows.map(entry => ({ name: entry.name.trim(), ...(entry.from === undefined ? {} : { from: entry.from }) })) });
    drafts.delete(project.id); toast(t('common.saved')); await refresh();
  }, 'primary');
  const reset = button(t('phases.reset'), () => { drafts.delete(project.id); draft = fresh(); render(); });
  const actions = el('div', 'row'); actions.append(add, save, reset);
  render();
  return disclosure(t('phases.edit'), el('p', 'muted', t('phases.hint')), stale, list, actions);
}
