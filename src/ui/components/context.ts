import type { TaskContext, ContextPreview, ContextManifest } from '../../shared/types.ts';
import { request, query } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, button, area, modal, UserError } from './dom.ts';

export function contextButton(project: string, task: string, pick: () => { ai: string; model?: string }): HTMLButtonElement {
  return button(t('context.title'), async () => {
    let value = await request<TaskContext>(query('/api/task/context', { project, task }));
    const node = el('div');
    const decisions = area(value.decisions, t('context.decisions'));
    const sources = area(value.sources.map(source => `${source.path}:${source.start}-${source.end} | ${source.priority ?? 0} | ${source.order ?? 0} | ${source.enabled !== false} | ${source.allocatedChars ?? 0}`).join('\n'), t('context.sources'));
    const decisionBudget = el('input'); decisionBudget.type = 'number'; decisionBudget.min = '0'; decisionBudget.max = '2000000'; decisionBudget.value = String(value.decisionBudget ?? 0);
    const result = el('div');
    async function save(): Promise<void> {
      const parsed = sources.value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const match = /^(.*):(\d+)-(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(true|false)\s*\|\s*(\d+)$/u.exec(line);
        if (!match) throw new UserError(t('context.invalidSource'));
        return { path: match[1]!.trim(), start: Number(match[2]), end: Number(match[3]), priority: Number(match[4]), order: Number(match[5]), enabled: match[6] === 'true', allocatedChars: Number(match[7]) };
      });
      value = await request<TaskContext>('/api/task/context', { project, task, context: { decisions: decisions.value, sources: parsed, decisionBudget: Number(decisionBudget.value), revision: value.revision } });
    }
    node.append(el('label', '', t('context.decisions')), decisions, el('label', '', t('context.decisionBudget')), decisionBudget, el('label', '', t('context.sourceBudgetFormat')), sources,
      button(t('context.save'), save), button(t('context.preview'), async () => {
        await save();
        const choice = pick();
        const preview = await request<ContextPreview>(query('/api/task/handoff', { project, task, ai: choice.ai, model: choice.model ?? '' }));
        result.replaceChildren(el('p', '', t('context.history', { start: preview.handoff.start ?? '—', end: preview.handoff.end ?? '—' })));
        if (preview.handoff.truncated || preview.context.truncated) result.append(el('p', 'warning', t('context.truncated')));
        result.append(el('pre', '', preview.context.text), el('pre', '', preview.handoff.text));
        for (const allocation of preview.context.allocations) result.append(el('p', '', `${allocation.id} · ${t(`context.status.${allocation.status}`)} · ${allocation.sentChars}/${allocation.allocatedChars} ${t('context.characters')}`));
      }), result);
    modal(t('context.title'), node);
  }, 'subtle');
}

/** Attach to a stored turn, using its actual request ID rather than rebuilding current sources. */
export function contextManifestButton(project: string, task: string, requestId: string): HTMLButtonElement {
  return button(t('context.preview'), async () => {
    const manifest = await request<ContextManifest | null>(query('/api/task/context/manifest', { project, task, request: requestId }));
    const node = el('div');
    if (!manifest) node.append(el('p', '', t('context.status.unavailable')));
    else {
      node.append(el('p', '', `${manifest.request} · ${manifest.ai} · ${manifest.at}`), el('pre', '', manifest.context.text), el('pre', '', manifest.handoff.text));
      for (const allocation of manifest.context.allocations) node.append(el('p', '', `${allocation.id} · ${t(`context.status.${allocation.status}`)} · ${allocation.sentChars}/${allocation.allocatedChars} ${t('context.characters')}`));
      node.append(el('pre', '', JSON.stringify({ allocations: manifest.context.allocations, providerTokens: manifest.providerTokens }, null, 2)));
    }
    modal(t('context.title'), node);
  }, 'subtle');
}
