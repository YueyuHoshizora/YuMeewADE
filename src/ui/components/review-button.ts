import type { ReviewCapability, ReviewInput, ReviewResult, ReviewHistory, ReviewFindingState, FileView } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, el, field, modal, run, select } from './dom.ts';
import { confirmUsageRound } from './usage-history.ts';

/** A dedicated API, never the ordinary writing-session send route. */
export async function reviewButton(project: string, task: string, pick: () => ReviewInput, onResult: (result: ReviewResult) => void, account: (ai: string) => string): Promise<HTMLElement> {
  const { providers } = await request<{ providers: Record<string, ReviewCapability> }>('/api/review/capabilities');
  const wrapper = el('span', 'readonly-review');
  const note = el('small', 'muted');
  let running = false;
  const stop = button(t('chat.stop'), async () => { await request('/api/review/stop', { project, task }); });
  stop.hidden = true;
  const action = button(t('readonlyReview.title'), async () => {
    const input = pick();
    if (running || !providers[input.ai]?.supported) return;
    if (!await confirmUsageRound({ project, task, ai: input.ai, account: account(input.ai) })) return;
    running = true;
    action.textContent = t('readonlyReview.running');
    refresh();
    try { onResult(await request<ReviewResult>('/api/review/run', { project, task, ...input })); }
    finally { running = false; action.textContent = t('readonlyReview.title'); refresh(); }
  });
  function refresh(): void {
    const capability = providers[pick().ai];
    action.disabled = running || !capability?.supported;
    stop.hidden = !running;
    note.textContent = t(!capability?.supported ? 'readonlyReview.unsupported' : capability.enforcement === 'native-sandbox' ? 'readonlyReview.native' : 'readonlyReview.tools');
    action.title = note.textContent;
  }
  wrapper.addEventListener('pointerenter', refresh);
  wrapper.addEventListener('focusin', refresh);
  wrapper.addEventListener('review-pick-change', refresh);
  const historyButton = button(t('review.history'), async () => {
    const root = el('div', 'form');
    let history = await request<ReviewHistory>(query('/api/review/history', { project, task }));
    function render(): void {
      const gate = el('input'); gate.type = 'checkbox'; gate.checked = history.requireApproval;
      gate.addEventListener('change', () => { void run(async () => { history = await request<ReviewHistory>('/api/review/gate', { project, task, required: gate.checked }); render(); }); });
      root.replaceChildren(field(t('review.gate'), gate));
      if (history.stale) root.append(el('p', 'warning', t('review.stale')));
      for (const snapshot of [...history.snapshots].reverse()) {
        const section = el('section', 'card');
        section.append(el('p', '', `${snapshot.at} · ${snapshot.ai} · ${t(snapshot.approved ? 'review.approved' : 'review.unapproved')}`), el('code', '', `${snapshot.revision} · ${snapshot.content}`));
        const raw = el('details'); raw.append(el('summary', '', t('workflow.output')), el('pre', '', snapshot.text)); section.append(raw);
        for (const finding of snapshot.findings) {
          const item = el('section', 'card');
          item.append(el('strong', '', `${t(`review.${finding.severity}`)} · ${t(`review.${finding.state}`)} · ${finding.path}:${finding.line}`), el('p', '', finding.message), el('pre', '', finding.evidence));
          item.append(button(`${finding.path}:${finding.line}`, async () => {
            const file = await request<FileView>(query('/api/task/file', { project, task, path: finding.path }));
            modal(`${finding.path}:${finding.line}`, el('pre', '', file.text.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n')));
          }));
          const state = select(['open', 'resolved', 'dismissed'].map(value => ({ value, label: t(`review.${value}` as Parameters<typeof t>[0]) })), finding.state);
          const evidence = area(''); evidence.maxLength = 10000;
          item.append(field(t('review.evidence'), evidence), state, button(t('common.save'), async () => {
            history = await request<ReviewHistory>('/api/review/finding', { project, task, snapshot: snapshot.id, finding: finding.id, state: state.value as ReviewFindingState, evidence: evidence.value }); render();
          }));
          for (const transition of finding.transitions) item.append(el('p', '', `${transition.at} · ${t(`review.${transition.state}`)} · ${transition.evidence}`));
          section.append(item);
        }
        root.append(section);
      }
      root.append(button(t('readonlyReview.title'), async () => {
        const input = pick();
        if (!await confirmUsageRound({ project, task, ai: input.ai, account: account(input.ai) })) return;
        onResult(await request<ReviewResult>('/api/review/run', { project, task, ...input }));
        history = await request<ReviewHistory>(query('/api/review/history', { project, task })); render();
      }));
    }
    render(); modal(t('review.history'), root);
  });
  refresh(); wrapper.append(action, stop, note, historyButton);
  return wrapper;
}
