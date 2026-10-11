import type { AiPick, AppState } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import { el, field, select } from './dom.ts';
import { aiLabel, effortLabel } from './display.ts';

export function aiPicker(state: AppState, initial: AiPick, onChange?: (pick: AiPick) => void, human = false, compact = false): { node: HTMLElement; value: () => AiPick } {
  const node = el('div', 'picker row');
  const ai = select([...state.ais.filter(a => a.name !== 'mock' && (human || a.available)).map(a => ({ value: a.name, label: aiLabel(a.name) })), ...(human ? [{ value: '人', label: t('ai.human') }] : [])], initial.ai);
  if (!ai.value) ai.selectedIndex = 0;
  const model = select([]); const effort = select([]);
  const value = (): AiPick => ({ ai: ai.value, model: model.value, effort: effort.value });
  function fillModels(keep = ''): void {
    const info = state.ais.find(a => a.name === ai.value);
    const hidden = state.settings.hiddenModels[ai.value] ?? [];
    const order = state.settings.modelOrder[ai.value] ?? [];
    const models = [...(info?.models ?? [])].filter(m => !hidden.includes(m.id) || m.id === keep).sort((a, b) => {
      const aa = order.indexOf(a.id); const bb = order.indexOf(b.id); return (aa < 0 ? Infinity : aa) - (bb < 0 ? Infinity : bb);
    });
    model.replaceChildren(...models.map(m => { const o = el('option', '', m.label); o.value = m.id; return o; }));
    if (keep && !models.some(m => m.id === keep)) { const option = el('option', '', keep); option.value = keep; model.append(option); }
    if (!model.options.length && ai.value !== '人') { const option = el('option', '', t('ai.default')); option.value = ''; model.append(option); }
    model.value = keep || models[0]?.id || ''; if (!model.value) model.selectedIndex = 0;
    model.disabled = ai.value === '人'; fillEfforts();
  }
  function fillEfforts(keep = ''): void {
    const m = state.ais.find(a => a.name === ai.value)?.models.find(m => m.id === model.value);
    const choices = m?.efforts ?? [];
    effort.replaceChildren(...choices.map(e => { const o = el('option', '', effortLabel(e)); o.value = e; return o; }));
    effort.value = choices.includes(keep) ? keep : m?.defaultEffort ?? choices[0] ?? '';
    effort.disabled = !choices.length;
  }
  const sameAi = ai.value === initial.ai;
  fillModels(sameAi ? initial.model : ''); fillEfforts(sameAi ? initial.effort : '');
  ai.onchange = () => { fillModels(); onChange?.(value()); };
  model.onchange = () => { fillEfforts(); onChange?.(value()); };
  effort.onchange = () => onChange?.(value());
  if (compact) {
    node.classList.add('compact-picker');
    for (const [control, label] of [[ai, t('ai.label')], [model, t('ai.model')], [effort, t('ai.effort')]] as const) {
      control.setAttribute('aria-label', label); control.title = label; node.append(control);
    }
  } else node.append(field(t('ai.label'), ai), field(t('ai.model'), model), field(t('ai.effort'), effort));
  return { node, value };
}
