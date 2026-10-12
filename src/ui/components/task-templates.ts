import type { ProjectView, Task, TaskTemplate } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, confirmModal, disclosure, el, field, input, row, run, select, storeLocal, taskHash, type ViewContext } from './dom.ts';

export function taskTemplates(context: ViewContext, project: ProjectView): HTMLElement {
  const list = el('div'); const name = input(); name.maxLength = 60;
  const source = select(project.tasks.map(task => ({ value: task.id, label: task.title })));
  const instruction = area(); instruction.maxLength = 10000;
  const scope = select([{ value: 'project', label: t('tasks.projectTemplate') }, { value: 'workspace', label: t('tasks.workspaceTemplate') }]); scope.setAttribute('aria-label', `${t('tasks.projectTemplate')} / ${t('tasks.workspaceTemplate')}`);
  async function reload(): Promise<void> {
    const response = await request<{ templates: TaskTemplate[] }>(query('/api/task/templates', { project: project.id }));
    list.replaceChildren(...response.templates.map(template => row(
      el('span', '', `${template.name} · ${template.title} · ${t(template.scope === 'project' ? 'tasks.projectTemplate' : 'tasks.workspaceTemplate')}`),
      button(t('tasks.fromTemplate'), async () => {
        const result = await request<{ task: Task; instruction: string }>('/api/task/template/create', { project: project.id, name: template.name, scope: template.scope });
        storeLocal(`yumeewade.draft.${project.id}/${result.task.id}`, result.instruction);
        await context.refresh(); location.hash = taskHash(project.id, result.task.id);
      }),
      button(t('common.remove'), async () => {
        if (!await confirmModal(t('common.remove'), template.name, t('common.remove'))) return;
        await request('/api/task/template/delete', { project: project.id, name: template.name, scope: template.scope, confirm: true });
        await reload();
      }, 'danger'),
    )));
    if (!response.templates.length) list.append(el('p', 'muted', t('common.empty')));
  }
  const node = disclosure(t('tasks.templates'), list, field(t('tasks.templateName'), name), field(t('tasks.templateSource'), source), field(t('tasks.instruction'), instruction), scope,
    button(t('tasks.saveTemplate'), async () => {
      await request('/api/task/template/save', { project: project.id, task: source.value, name: name.value.trim(), instruction: instruction.value, scope: scope.value });
      await reload();
    }));
  node.addEventListener('toggle', () => { if (node.open) void run(reload); });
  return node;
}
