import type { UsageScope, WorkflowPlan, WorkflowStep } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, confirmModal, el, field, modal, row, run, select, type ViewContext } from './dom.ts';
import { confirmUsageRound, workflowBudgetRisk } from './usage-history.ts';

export function workflowButton(context: ViewContext, project: string, task: string): HTMLElement {
  return button(t('workflow.title'), async () => {
    let plan = await request<WorkflowPlan>(query('/api/task/workflow', { project, task }));
    const root = el('div', 'form workflow-panel');
    const status = el('p');
    const risk = el('div'); let riskSnapshot = ''; let riskSerial = 0;
    async function renderRisk(): Promise<void> {
      const snapshot = JSON.stringify([plan.cursor, plan.state, plan.steps[plan.cursor]]);
      if (snapshot === riskSnapshot) return;
      riskSnapshot = snapshot; const serial = ++riskSerial; risk.replaceChildren();
      if (plan.state === 'running' || !plan.steps[plan.cursor]) return;
      const scope = await request<UsageScope | null>(query('/api/task/workflow/next', { project, task }));
      if (scope && serial === riskSerial) risk.append(workflowBudgetRisk(scope));
    }
    const dependencies = el('div', 'workflow-dependencies');
    const choices: { id: string; node: HTMLInputElement }[] = [];
    for (const candidate of context.state.projects.find(p => p.id === project)?.tasks ?? []) {
      if (candidate.id === task) continue;
      const check = el('input'); check.type = 'checkbox'; check.checked = plan.dependencies.includes(candidate.id);
      choices.push({ id: candidate.id, node: check });
      dependencies.append(field(`${candidate.title} (${candidate.state})`, check));
    }
    const steps = el('div', 'workflow-steps');
    const editors: { role: HTMLSelectElement; text: HTMLTextAreaElement; review: HTMLInputElement; remove: HTMLButtonElement }[] = [];
    const roles = Object.keys(context.state.roles.roles).map(value => ({ value, label: value }));
    function addStep(step?: WorkflowStep): void {
      const role = select(roles, step?.role ?? roles[0]?.value ?? '');
      const text = area(step?.text ?? ''); text.maxLength = context.state.limits.promptChars;
      const review = el('input'); review.type = 'checkbox'; review.checked = step?.review ?? false;
      const block = el('section', 'card');
      const remove = button(t('common.remove'), () => { editors.splice(editors.indexOf(editor), 1); block.remove(); });
      const editor = { role, text, review, remove }; editors.push(editor);
      block.append(field(t('workflow.role'), role), field(t('workflow.instruction'), text), field(t('workflow.readonly'), review), remove);
      steps.append(block);
    }
    plan.steps.forEach(addStep);
    function renderStatus(): void {
      status.textContent = `${t(`workflow.state.${plan.state}`)} · ${plan.cursor}/${plan.steps.length}${plan.reason ? ` · ${t(`detail.${plan.reason}` as Parameters<typeof t>[0])}` : ''}`;
      void run(renderRisk);
      save.disabled = plan.state === 'running'; start.disabled = plan.state === 'running' || plan.cursor >= plan.steps.length;
      stop.hidden = plan.state !== 'running'; approve.hidden = plan.reason !== 'workflow_human';
      editors.forEach((editor, index) => { editor.role.disabled = editor.text.disabled = editor.review.disabled = editor.remove.disabled = plan.state === 'running' || index < plan.cursor; });
      evidence.hidden = approve.hidden;
      rerunCurrent.disabled = plan.state === 'running' || plan.cursor >= plan.steps.length;
      history.replaceChildren(...plan.results.map((result, index) => {
        const block = el('section', 'card');
        block.append(el('p', result.ok ? '' : 'error-mark', `${(result.step ?? index) + 1} · ${result.role} · ${result.ai} · ${t(result.ok ? 'verify.pass' : 'verify.fail')} · ${result.at}`));
        if (result.invalidatedAt) block.append(el('p', 'muted', t('workflow.invalidated')));
        if (result.evidence) block.append(el('p', '', result.evidence));
        if (result.output) { const details = el('details'); details.append(el('summary', '', t('workflow.output')), el('pre', '', result.output)); block.append(details); }
        if (result.request && !result.reviewSnapshot) block.append(button(t('copy.diff'), async () => {
          const diff = await request<unknown>(query('/api/chat/turn-diff', { project, task, request: result.request }));
          modal(t('copy.diff'), el('pre', '', JSON.stringify(diff, null, 2)));
        }));
        block.append(button(t('verify.run'), async () => {
          const verification = await request<unknown>(query('/api/task/verify', { project, task }));
          modal(t('verify.run'), el('pre', '', JSON.stringify(verification, null, 2)));
        }));
        if ((result.step ?? index) <= plan.cursor && (result.step ?? index) < plan.steps.length) block.append(button(t('workflow.rerun'), async () => {
          if (!await confirmModal(t('workflow.rerun'), t('workflow.preserve'))) return;
          plan = await request<WorkflowPlan>('/api/task/workflow/rerun', { project, task, from: result.step ?? index }); renderStatus();
        }));
        return block;
      }));
    }
    const save = button(t('common.save'), async () => {
      if (!await confirmModal(t('workflow.title'), t('workflow.preserve'))) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/configure', { project, task, dependencies: choices.filter(c => c.node.checked).map(c => c.id), steps: editors.map(e => ({ role: e.role.value, text: e.text.value, review: e.review.checked })) });
      renderStatus(); await context.refresh();
    });
    const start = button(t('workflow.start'), async () => {
      if (!await confirmModal(t('workflow.title'), t('workflow.startConfirm'), t('workflow.start'))) return;
      const scope = await request<UsageScope | null>(query('/api/task/workflow/next', { project, task }));
      if (scope && !await confirmUsageRound(scope)) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/start', { project, task }); renderStatus();
    }, 'primary');
    const stop = button(t('chat.stop'), async () => { await request('/api/task/workflow/stop', { project, task }); await refresh(); });
    const approve = button(t('workflow.approveHuman'), async () => {
      if (!await confirmModal(t('workflow.approveHuman'), t('workflow.approveConfirm'))) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/approve', { project, task, evidence: evidence.value }); renderStatus();
    });
    const rerunCurrent = button(t('workflow.rerun'), async () => {
      if (!await confirmModal(t('workflow.rerun'), t('workflow.preserve'))) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/rerun', { project, task, from: plan.cursor }); renderStatus();
    });
    const history = el('div', 'workflow-results');
    const evidence = area(''); evidence.maxLength = 10000; evidence.placeholder = t('review.evidence');
    root.append(el('p', 'muted', t('workflow.help')), status, risk, field(t('workflow.dependencies'), dependencies), steps,
      button(t('workflow.add'), () => addStep()), evidence, row(save, start, stop, approve, rerunCurrent), history);
    modal(t('workflow.title'), root); renderStatus();
    async function refresh(): Promise<void> {
      plan = await request<WorkflowPlan>(query('/api/task/workflow', { project, task }));
      if (root.isConnected) renderStatus();
    }
    const timer = window.setInterval(() => { if (root.isConnected) void run(refresh); else window.clearInterval(timer); }, 1500);
    root.closest('dialog')?.addEventListener('close', () => window.clearInterval(timer), { once: true });
  });
}
