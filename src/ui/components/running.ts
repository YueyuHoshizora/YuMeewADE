import type { AppState, RunningInfo } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { aiLabel, modelLabel } from './display.ts';
import { button, confirmModal, el, link, modal, row, run, setLocked, taskHash } from './dom.ts';
import { formatElapsed } from './elapsed.ts';

/** Chat turns stop through the chat API; read-only reviews through their own. */
export const stopRunning = (info: RunningInfo) => request(info.kind === 'review' ? '/api/review/stop' : '/api/chat/stop', { project: info.project, task: info.task });

/** 底部狀態列的「執行中 N」；沒有執行中的 AI 就不顯示。 */
export function runningChip(state: AppState): HTMLButtonElement | null {
  if (!state.running.length) return null;
  const chip = button(t('running.chip', { n: state.running.length }), () => openRunning(state), 'running-chip');
  chip.title = t('running.title');
  return chip;
}

function openRunning(state: AppState, now = Date.now()): void {
  const stopButtons: HTMLButtonElement[] = [];
  const items = state.running.map(info => {
    const task = state.projects.find(p => p.id === info.project)?.tasks.find(x => x.id === info.task);
    const open = link(task?.title ?? info.task, taskHash(info.project, info.task), 'running-title');
    open.addEventListener('click', () => open.closest('dialog')?.close());
    const stopOne = button(t('chat.stop'), () => run(async () => {
      setLocked(stopOne, true);
      stopOne.textContent = t('running.stopping');
      // Stays locked once stopping succeeds; a failed stop must remain retryable.
      try { await stopRunning(info); } catch (error) { setLocked(stopOne, false); stopOne.textContent = t('chat.stop'); throw error; }
    }), 'danger');
    stopButtons.push(stopOne);
    const model = [...(info.kind === 'review' ? [t('running.review')] : []), aiLabel(info.ai), modelLabel(state, info.ai, info.model)].filter(Boolean).join(' · ');
    return row(open, el('span', 'muted', `${model} · ${info.approvals?.length ? t('permission.waiting') : formatElapsed(now - Date.parse(info.startedAt))}`), stopOne);
  });
  const stopAll = button(t('running.stopAll'), () => run(async () => {
    if (!await confirmModal(t('running.stopAll'), t('running.stopAllConfirm', { n: state.running.length }), t('chat.stop'))) return;
    setLocked(stopAll, true);
    for (const b of stopButtons) { setLocked(b, true); b.textContent = t('running.stopping'); }
    try { await Promise.all(state.running.map(stopRunning)); }
    catch (error) { for (const b of [stopAll, ...stopButtons]) setLocked(b, false); for (const b of stopButtons) b.textContent = t('chat.stop'); throw error; }
  }), 'danger');
  modal(t('running.title'), ...items, ...(state.running.length > 1 ? [stopAll] : []));
}
