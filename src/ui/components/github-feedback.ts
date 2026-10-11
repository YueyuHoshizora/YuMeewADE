import type { LinkedFeedback } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, confirmModal, el, field, input, link, row, storeLocal, type ViewContext } from './dom.ts';

export function githubLinkedFeedbackPanel(context: ViewContext, project: string, task: string, useDraft: (draft: string) => void): HTMLElement {
  const panel = el('section', 'form'); const content = el('div', 'form');
  let current: LinkedFeedback | null = null;
  const ids = { project, task };
  const remoteAction = async (operation: 'reply' | 'resolve' | 'unresolve' | 'update' | 'close', body = '', title = '') => {
    if (!current) return;
    if (!await confirmModal(t(`feedback.${operation}`), `${current.repository} · ${current.kind === 'thread' ? 'PR' : 'Issue'} #${current.number}\n${current.threadId}\n${current.url}\n${title}\n${body}\n${t('feedback.confirm')}`, t(`feedback.${operation}`))) return;
    current = await request<LinkedFeedback>(`/api/git/feedback-${operation}`, { ...ids, revision: current.revision, body, title, confirmed: true });
    render(); await context.refresh();
  };
  const render = () => {
    content.replaceChildren(); if (!current) return;
    const anchor = link(`${current.repository} #${current.number}`, current.url); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    const draft = area(current.draft); draft.maxLength = context.state.limits.promptChars; draft.rows = 8;
    content.append(el('h3', '', t('feedback.linked')), anchor, el('p', '', current.kind === 'thread' ? `${current.resolved ? t('feedback.resolved') : t('feedback.unresolved')} · ${current.path}:${current.line ?? ''}` : current.state), el('p', '', `${current.threadId} ${current.commentId}`), el('pre', '', current.source), el('p', '', t('feedback.noAi')), field(t('github.instruction'), draft), row(button(t('feedback.save'), async () => {
      if (!current) return;
      current = await request<LinkedFeedback>('/api/git/feedback-draft', { ...ids, revision: current.revision, draft: draft.value }); render();
    }), button(t('feedback.use'), () => { storeLocal(`yumeewade.draft.${project}/${task}`, draft.value); useDraft(draft.value); })));
    content.append(button(t('feedback.refresh'), async () => {
      if (!current) return;
      current = await request<LinkedFeedback>('/api/git/feedback-refresh', { ...ids, revision: current.revision }); render();
    }));
    const reply = area(); reply.maxLength = 10000;
    content.append(field(t('feedback.replyBody'), reply), button(t('feedback.reply'), () => remoteAction('reply', reply.value)));
    if (current.kind === 'thread') content.append(button(t(current.resolved ? 'feedback.unresolve' : 'feedback.resolve'), () => remoteAction(current?.resolved ? 'unresolve' : 'resolve')));
    else {
      const title = input(); title.maxLength = 300; const body = area(); body.maxLength = 10000;
      content.append(field(t('common.title'), title), field(t('workbench.body'), body), row(button(t('feedback.update'), () => remoteAction('update', body.value, title.value)), button(t('feedback.close'), () => remoteAction('close'))));
    }
  };
  panel.append(content);
  void request<LinkedFeedback | null>(query('/api/git/linked-feedback', ids)).then(value => { current = value; render(); }).catch(() => { content.append(el('p', '', t('common.error'))); });
  return panel;
}
