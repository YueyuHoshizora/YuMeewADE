import type { UsageScope, VerifyStatus, WorkflowPlan, WorkflowStep } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, confirmModal, el, field, modal, row, run, select, taskHash, UserError, type ViewContext } from './dom.ts';
import { confirmUsageRound, workflowBudgetRisk } from './usage-history.ts';
import { readonlyDiffView, verificationStatusView } from './verification-view.ts';
import { renderWorkflowTimeline } from './workflow-timeline.ts';

export function workflowButton(context: ViewContext, project: string, task: string): HTMLElement {
  return button(t('workflow.title'), async () => {
    let plan = await request<WorkflowPlan>(query('/api/task/workflow', { project, task }));
    const root = el('div', 'form workflow-panel');
    const status = el('p');
    const risk = el('div'); let riskSnapshot = ''; let riskSerial = 0;
    async function renderRisk(): Promise<void> {
      const snapshot = JSON.stringify([plan.revision, plan.state, plan.nodeStates]);
      if (snapshot === riskSnapshot) return;
      riskSnapshot = snapshot; const serial = ++riskSerial; risk.replaceChildren();
      if (plan.state === 'running' || !plan.steps.some(s => plan.nodeStates?.[s.id!] === 'pending')) return;
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
    const editors: { role: HTMLSelectElement; text: HTMLTextAreaElement; review: HTMLInputElement; remove: HTMLButtonElement; id: HTMLInputElement; needs: HTMLInputElement; upstream: HTMLInputElement; condition: HTMLInputElement; kind: HTMLSelectElement }[] = [];
    const roles = Object.keys(context.state.roles.roles).map(value => ({ value, label: value }));
    function addStep(step?: WorkflowStep): void {
      const role = select(roles, step?.role ?? roles[0]?.value ?? '');
      const text = area(step?.text ?? ''); text.maxLength = context.state.limits.promptChars;
      const review = el('input'); review.type = 'checkbox'; review.checked = step?.review ?? false;
      const id = el('input'); id.value = step?.id ?? `node-${editors.length + 1}`; id.maxLength = 80;
      const needs = el('input'); needs.value = step?.dependsOn?.join(',') ?? '';
      const upstream = el('input'); upstream.value = step?.upstream?.join(',') ?? '';
      const condition = el('input'); condition.value = step?.condition ? `${step.condition.node}:${step.condition.outcome}` : '';
      const kind = select([{ value: 'expert', label: t('workflow.graph.expert') }, { value: 'join', label: t('workflow.graph.join') }, { value: 'integration', label: t('workflow.native.integration') }, { value: 'verify', label: t('verify.run') }, { value: 'review', label: t('workflow.readonly') }], step?.kind ?? 'expert');
      const block = el('section', 'card');
      const remove = button(t('common.remove'), () => { editors.splice(editors.indexOf(editor), 1); block.remove(); });
      const editor = { role, text, review, remove, id, needs, upstream, condition, kind }; editors.push(editor);
      block.append(field(t('workflow.graph.id'), id), field(t('workflow.graph.needs'), needs), field(t('workflow.native.upstream'), upstream), field(t('workflow.graph.condition'), condition), field(t('workflow.graph.kind'), kind), field(t('workflow.role'), role), field(t('workflow.instruction'), text), field(t('workflow.readonly'), review), remove);
      steps.append(block);
    }
    plan.steps.forEach(addStep);
    function renderStatus(): void {
      status.textContent = `${t(`workflow.state.${plan.state}`)} · ${plan.cursor}/${plan.steps.length}${plan.reason ? ` · ${t(`detail.${plan.reason}` as Parameters<typeof t>[0])}` : ''}`;
      // "Blocked" only means the gates are not all satisfied yet; a gate without a result has not run rather than failed.
      if (plan.delivery) status.textContent += ` · ${t('workflow.native.delivery')}: ${t(plan.delivery.state === 'ready' ? 'workflow.delivery.ready' : 'workflow.delivery.blocked')}${plan.delivery.gates.map(gate => ` · ${gate.node}: ${t(gate.ok ? 'verify.pass' : gate.at ? 'verify.fail' : 'workflow.delivery.pending')}`).join('')}`;
      timeline.replaceChildren(renderWorkflowTimeline(plan));
      void run(renderRisk);
      save.disabled = plan.state === 'running';
      start.disabled = plan.state === 'running' || !plan.steps.some(s => plan.nodeStates?.[s.id!] === 'pending' || plan.nodeStates?.[s.id!] === 'human' && !s.review && context.state.roles.roles[s.role]?.main.cli !== '人');
      stop.hidden = plan.state !== 'running';
      approve.hidden = plan.reason !== 'workflow_human' || !plan.steps.some(s => plan.nodeStates?.[s.id!] === 'human' && context.state.roles.roles[s.role]?.main.cli === '人');
      editors.forEach(editor => { editor.role.disabled = editor.text.disabled = editor.review.disabled = editor.remove.disabled = editor.id.disabled = editor.needs.disabled = editor.upstream.disabled = editor.condition.disabled = editor.kind.disabled = plan.state === 'running'; });
      evidence.hidden = approve.hidden;
      rerunCurrent.disabled = plan.state === 'running' || plan.cursor >= plan.steps.length;
      history.replaceChildren(...plan.results.map((result, index) => {
        const block = el('section', 'card');
        block.append(el('p', result.ok ? '' : 'error-mark', `${result.node ?? (result.step ?? index) + 1} · ${result.role} · ${result.ai} · ${t(result.ok ? 'verify.pass' : 'verify.fail')} · ${result.at}`));
        if (result.task) block.append(button(`${t('workflow.graph.branch')} ${result.task}`, async () => { await context.refresh(); root.closest('dialog')?.close(); location.hash = taskHash(project, result.task!); }));
        const candidate = result.node ? plan.candidates?.[result.node] : undefined;
        if (candidate) {
          block.append(el('pre', '', candidate.conflicts.join('\n')), button(t('copy.diff'), () => { modal(t('copy.diff'), el('pre', '', candidate.diff)); }));
          if (candidate.state === 'conflict') block.append(button(t('workflow.native.resolve'), async () => {
            plan = await request<WorkflowPlan>('/api/task/workflow/integration/resolve', { project, task, node: result.node, revision: plan.revision }); renderStatus();
          }));
        }
        if (result.invalidatedAt) block.append(el('p', 'muted', t('workflow.invalidated')));
        if (result.evidence) block.append(el('p', '', result.evidence));
        if (result.output) { const details = el('details'); details.append(el('summary', '', t('workflow.output')), el('pre', '', result.output)); block.append(details); }
        if (result.request && !result.reviewSnapshot) block.append(button(t('copy.diff'), async () => {
          const diff = await request<{ diff: string; truncated: boolean }>(query('/api/chat/turn-diff', { project, task: result.task ?? task, request: result.request }));
          modal(t('copy.diff'), readonlyDiffView(diff));
        }));
        block.append(button(t('verify.latest'), async () => {
          const verification = await request<VerifyStatus | null>(query('/api/task/verify', { project, task: result.task ?? task }));
          modal(t('verify.latest'), ...verificationStatusView(verification));
        }));
        if ((result.step ?? index) < plan.steps.length) block.append(button(t('workflow.rerun'), async () => {
          if (!await confirmModal(t('workflow.rerun'), t('workflow.preserve'), t('workflow.rerun'))) return;
          plan = await request<WorkflowPlan>('/api/task/workflow/rerun', { project, task, revision: plan.revision, from: result.step ?? index }); renderStatus();
        }));
        return block;
      }));
    }
    const save = button(t('common.save'), async () => {
      if (!await confirmModal(t('workflow.title'), t('workflow.preserve'), t('common.save'))) return;
      const graph = editors.map(e => {
        const [node, outcome] = e.condition.value.trim().split(':');
        if (node && outcome !== 'success' && outcome !== 'approved' && outcome !== 'failure') throw new UserError(t('workflow.graph.condition'));
        return { id: e.id.value.trim(), dependsOn: e.needs.value.split(',').map(id => id.trim()).filter(Boolean), upstream: e.upstream.value.split(',').map(id => id.trim()).filter(Boolean), kind: e.kind.value as WorkflowStep['kind'], role: e.role.value, text: e.text.value, review: e.review.checked, ...(node ? { condition: { node, outcome: outcome as 'success' | 'approved' | 'failure' } } : {}) };
      });
      plan = await request<WorkflowPlan>('/api/task/workflow/configure', { project, task, revision: plan.revision, dependencies: choices.filter(c => c.node.checked).map(c => c.id), steps: graph });
      renderStatus(); await context.refresh();
    });
    const start = button(t('workflow.start'), async () => {
      if (!await confirmModal(t('workflow.title'), t('workflow.graph.help'), t('workflow.start'))) return;
      const scope = await request<UsageScope | null>(query('/api/task/workflow/next', { project, task }));
      if (scope && !await confirmUsageRound(scope)) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/start', { project, task }); renderStatus();
    }, 'primary');
    const stop = button(t('chat.stop'), async () => { await request('/api/task/workflow/stop', { project, task }); await refresh(); });
    const approve = button(t('workflow.approveHuman'), async () => {
      if (!await confirmModal(t('workflow.approveHuman'), t('workflow.approveConfirm'), t('workflow.approveHuman'))) return;
      plan = await request<WorkflowPlan>('/api/task/workflow/approve', { project, task, revision: plan.revision, node: plan.steps.find(s => plan.nodeStates?.[s.id!] === 'human' && context.state.roles.roles[s.role]?.main.cli === '人')?.id, evidence: evidence.value }); renderStatus();
    });
    const rerunCurrent = button(t('workflow.rerun'), async () => {
      if (!await confirmModal(t('workflow.rerun'), t('workflow.preserve'), t('workflow.rerun'))) return;
      const from = plan.steps.findIndex(step => ['pending', 'failed', 'human'].includes(plan.nodeStates?.[step.id!] ?? ''));
      plan = await request<WorkflowPlan>('/api/task/workflow/rerun', { project, task, revision: plan.revision, from }); renderStatus();
    });
    const history = el('div', 'workflow-results');
    const timeline = el('div');
    const evidence = area(''); evidence.maxLength = 10000; evidence.placeholder = t('review.evidence');
    root.append(el('p', 'muted', t('workflow.help')), status, risk, field(t('workflow.dependencies'), dependencies), steps,
      button(t('workflow.add'), () => addStep()), evidence, row(save, start, stop, approve, rerunCurrent), timeline, history);
    root.prepend(el('p', 'muted', t('workflow.graph.help')));
    const graphStatus = el('pre'); graphStatus.hidden = true; root.append(graphStatus);
    modal(t('workflow.title'), root); renderStatus();
    async function refresh(): Promise<void> {
      plan = await request<WorkflowPlan>(query('/api/task/workflow', { project, task }));
      if (root.isConnected) renderStatus();
      graphStatus.textContent = plan.steps.map(step => `${step.id} [${plan.nodeStates?.[step.id!] ?? 'pending'}] ← ${step.dependsOn?.join(', ') ?? ''}${step.condition ? ` (${step.condition.node}:${step.condition.outcome})` : ''}${plan.branchTasks?.[step.id!] ? ` · ${plan.branchTasks[step.id!]}` : ''}`).join('\n');
      graphStatus.hidden = !plan.steps.length;
    }
    const timer = window.setInterval(() => { if (root.isConnected) void run(refresh); else window.clearInterval(timer); }, 1500);
    root.closest('dialog')?.addEventListener('close', () => window.clearInterval(timer), { once: true });
  });
}
