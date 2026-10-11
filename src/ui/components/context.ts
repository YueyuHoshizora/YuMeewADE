import type { TaskContext, ContextPreview } from '../../shared/types.ts';
import { request, query } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, button, area, modal } from './dom.ts';

export function contextButton(project: string, task: string, pick: () => { ai: string; model?: string }): HTMLButtonElement {
  return button(t('context.title'), async () => {
    const value = await request<TaskContext>(query('/api/task/context', { project, task }));
    const node = el('div');
    const decisions = area(value.decisions, t('context.decisions'));
    const sources = area(value.sources.map(source => `${source.path}:${source.start}-${source.end}`).join('\n'), t('context.sources'));
    const result = el('div');
    async function save(): Promise<void> {
      const parsed = sources.value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const match = /^(.*):(\d+)-(\d+)$/u.exec(line);
        if (!match) throw new Error(t('context.invalidSource'));
        return { path: match[1]!, start: Number(match[2]), end: Number(match[3]) };
      });
      await request('/api/task/context', { project, task, context: { decisions: decisions.value, sources: parsed } });
    }
    node.append(el('label', '', t('context.decisions')), decisions, el('label', '', t('context.sources')), sources,
      button(t('context.save'), save), button(t('context.preview'), async () => {
        await save();
        const choice = pick();
        const preview = await request<ContextPreview>(query('/api/task/handoff', { project, task, ai: choice.ai, model: choice.model ?? '' }));
        result.replaceChildren(el('p', '', t('context.history', { start: preview.handoff.start ?? '—', end: preview.handoff.end ?? '—' })));
        if (preview.handoff.truncated || preview.context.truncated) result.append(el('p', 'warning', t('context.truncated')));
        result.append(el('pre', '', preview.context.text), el('pre', '', preview.handoff.text));
      }), result);
    modal(t('context.title'), node);
  }, 'subtle');
}
