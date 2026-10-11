import type { WorkflowPlan, WorkflowStep } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, confirmModal, el, field, modal, row, run, select, type ViewContext } from './dom.ts';

export function workflowButton(context: ViewContext, project: string, task: string): HTMLElement {
  return button(t('workflow.title'), async () => {
    let plan = await request<WorkflowPlan>(query('/api/task/workflow', { project, task }));
    const root = el('div', 'form workflow-panel');
    const status = el('p');
    const dependencies = el('div', 'workflow-dependencies');
    const choices: { id: string; node: HTMLInputElement }[] = [];
    for (const candidate of context.state.projects.find(p => p.id === project)?.tasks ?? []) {
      if (candidate.id === task) continue;
      const check = el('input'); check.type = 'checkbox'; check.checked = plan.dependencies.includes(candidate.id);
      choices.push({ id: candidate.id, node: check });
      dependencies.append(field(`${candidate.title} (${candidate.state})`, check));
    }
    const steps = el('div', 'workflow-steps');
    const editors: { role: HTMLSelectElement; text: HTMLTextAreaElement; review: HTMLInputElement }[] = [];
    const roles = Object.keys(context.state.roles.roles).map(value => ({ value, label: value }));
    function addStep(step?: WorkflowStep): void {
      const role = select(roles, step?.role ?? roles[0]?.value ?? '');
      const text = area(step?.text ?? ''); text.maxLength = context.state.limits.promptChars;
      const review = el('input'); review.type = 'checkbox'; review.checked = step?.review ?? false;
      const editor = { role, text, review }; editors.push(editor);
      const block = el('section', 'card');
      block.append(field(t('workflow.role'), role), field(t('workflow.instruction'), text), field(t('workflow.readonly'), review), button(t('common.remove'), () => { editors.splice(editors.indexOf(editor), 1); block.remove(); }));
      steps.append(block);
    }
    plan.steps.forEach(addStep);
    function renderStatus(): void {
      status.textContent = `${t(`workflow.state.${plan.state}`)} · ${plan.cursor}/${plan.steps.length}${plan.reason ? ` · ${t(`detail.${plan.reason}` as Parameters<typeof t>[0])}` : ''}`;
      save.disabled = plan.state === 'running'; start.disabled = plan.state === 'running' || plan.cursor >= plan.steps.length;
      stop.hidden = plan.state !== 'running'; approve.hidden = plan.reason !== 'workflow_human';
      history.replaceChildren(...plan.results.map(result => el('p', result.ok ? '' : 'error-mark', `${result.role} · ${result.ai} · ${t(result.ok ? 'verify.pass' : 'verify.fail')}`)));
    }
    const save = button(t('common.save'), async () => {
      if (!await confirmModal(t('workflow.title'), t('workflow.resetConfirm'))) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/configure', { project, task, dependencies: choices.filter(c => c.node.checked).map(c => c.id), steps: editors.map(e => ({ role: e.role.value, text: e.text.value, review: e.review.checked })) });
      renderStatus(); await context.refresh();
    });
    const start = button(t('workflow.start'), async () => {
      if (!await confirmModal(t('workflow.title'), t('workflow.startConfirm'), t('workflow.start'))) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/start', { project, task }); renderStatus();
    }, 'primary');
    const stop = button(t('chat.stop'), async () => { await request('/api/task/workflow/stop', { project, task }); await refresh(); });
    const approve = button(t('workflow.approveHuman'), async () => {
      if (!await confirmModal(t('workflow.approveHuman'), t('workflow.approveConfirm'))) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/approve', { project, task }); renderStatus();
    });
    const history = el('div', 'workflow-results');
    root.append(el('p', 'muted', t('workflow.help')), status, field(t('workflow.dependencies'), dependencies), steps,
      button(t('workflow.add'), () => addStep()), row(save, start, stop, approve), history);
    modal(t('workflow.title'), root); renderStatus();
    async function refresh(): Promise<void> {
      plan = await request<WorkflowPlan>(query('/api/task/workflow', { project, task }));
      if (root.isConnected) renderStatus();
    }
    const timer = window.setInterval(() => { if (root.isConnected) void run(refresh); else window.clearInterval(timer); }, 1500);
    root.closest('dialog')?.addEventListener('close', () => window.clearInterval(timer), { once: true });
  });
}
