import type { ReviewCapability, ReviewInput, ReviewResult } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el } from './dom.ts';

/** A dedicated API, never the ordinary writing-session send route. */
export async function reviewButton(project: string, task: string, pick: () => ReviewInput, onResult: (result: ReviewResult) => void): Promise<HTMLElement> {
  const { providers } = await request<{ providers: Record<string, ReviewCapability> }>('/api/review/capabilities');
  const wrapper = el('span', 'readonly-review');
  const note = el('small', 'muted');
  let running = false;
  const stop = button(t('chat.stop'), async () => { await request('/api/review/stop', { project, task }); });
  stop.hidden = true;
  const action = button(t('readonlyReview.title'), async () => {
    const input = pick();
    if (running || !providers[input.ai]?.supported) return;
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
  refresh(); wrapper.append(action, stop, note);
  return wrapper;
}
