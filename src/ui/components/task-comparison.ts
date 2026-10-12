import type { TaskComparison } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, field, modal, row, select } from './dom.ts';

export function taskComparisonButton(project: string): HTMLElement {
  return button(t('gitPrecision.compare'), async () => {
    const tasks = await request<{ id: string; title: string }[]>(query('/api/git/compare-options', { project }));
    const options = tasks.map(task => ({ value: task.id, label: `${task.title} (${task.id})` }));
    const left = select(options, tasks[0]?.id); const right = select(options, tasks[1]?.id);
    const results = el('div', 'form');
    const compare = button(t('gitPrecision.compare'), async () => {
      const result = await request<TaskComparison>(query('/api/git/compare-tasks', { project, leftTask: left.value, rightTask: right.value }));
      results.replaceChildren(el('p', '', `${result.leftBranch} → ${result.rightBranch}`));
      if (!result.files.length) results.append(el('p', '', t('gitPrecision.noDiff')));
      for (const file of result.files) results.append(el('h3', '', file.path), el('pre', '', file.patch));
      if (result.truncated) results.append(el('p', 'muted', t('gitPrecision.truncated', { n: result.files.length })));
    });
    compare.disabled = tasks.length < 2;
    modal(t('gitPrecision.compare'), el('p', '', t('gitPrecision.compareHint')), row(field(t('gitPrecision.left'), left), field(t('gitPrecision.right'), right)), compare, results);
  });
}
