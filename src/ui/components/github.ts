import type { GithubReviewStatus, Task } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, confirmModal, el, field, input, link, modal, row, storeLocal, taskHash, type ViewContext } from './dom.ts';

export function githubPullRequestPanel(project: string, task: string | undefined, branch: string, context: ViewContext): HTMLElement {
  const ids = { project, ...(task ? { task } : {}) };
  const panel = el('section', 'form'); const result = el('div', 'form');
  const openLink = (label: string, url: string) => { const anchor = link(label, url); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; return anchor; };
  const refresh = button(t('github.refresh'), async () => {
    const status = await request<GithubReviewStatus>(query('/api/git/pr-review', ids));
    result.replaceChildren();
    if (!status.available || !status.authenticated || !status.repository) {
      result.append(el('p', '', t(!status.available ? 'detail.gh_unavailable' : !status.authenticated ? 'detail.gh_auth_required' : 'detail.gh_remote_required'))); return;
    }
    const pr = status.pr;
    if (!pr) result.append(el('p', '', t('github.noPr')));
    else {
      result.append(openLink(`#${pr.number} ${pr.title}`, pr.url), el('p', '', `${pr.state} · ${pr.mergeState} · ${pr.reviewDecision || '—'}`), el('h4', '', t('github.checks')));
      for (const check of pr.checks) result.append(el('p', '', `${check.name}: ${check.status} ${check.conclusion}`));
      for (const [key, comments] of [['github.reviews', pr.reviews], ['github.comments', pr.comments]] as const) {
        result.append(el('h4', '', t(key)));
        for (const comment of comments) result.append(el('p', '', `${comment.author} ${comment.state ?? ''}`), el('pre', '', comment.body), ...(comment.url ? [openLink(t('github.open'), comment.url)] : []));
      }
      result.append(el('h4', '', t('github.threads')));
      for (const thread of pr.threads) {
        result.append(el('p', '', `${thread.resolved ? '✓' : '○'} ${thread.path}:${thread.line ?? ''}`));
        for (const comment of thread.comments) {
          result.append(el('p', '', comment.author), el('pre', '', comment.body), ...(comment.url ? [openLink(t('github.open'), comment.url)] : []));
          if (thread.id && comment.id && comment.url) result.append(button(t('feedback.create'), () => {
            const title = input(`${pr.title}: ${thread.path}`.slice(0, 300)); title.maxLength = 300;
            const draft = area(`${status.repository} PR #${pr.number}\n${thread.id} / ${comment.id}\n${thread.path}:${thread.line ?? ''}\n${comment.url}\n\n${comment.body}`.slice(0, context.state.limits.promptChars)); draft.maxLength = context.state.limits.promptChars; draft.rows = 12;
            const content = el('div', 'form'); content.append(field(t('common.title'), title), field(t('github.instruction'), draft), el('p', '', t('feedback.noAi')));
            modal(t('feedback.create'), content, button(t('feedback.create'), async () => {
              const created = await request<{ task: Task }>('/api/git/feedback-task', { project, repository: status.repository, number: pr.number, threadId: thread.id, commentId: comment.id, title: title.value, draft: draft.value });
              storeLocal(`yumeewade.draft.${project}/${created.task.id}`, draft.value);
              content.closest('dialog')?.close(); panel.closest('dialog')?.close();
              await context.refresh(); location.hash = taskHash(project, created.task.id);
            }));
          }));
        }
      }
    }
    const title = input(); title.maxLength = 300; const body = area(); body.maxLength = 60_000; const base = input('main'); const head = input(branch);
    result.append(field(t('common.title'), title), field(t('workbench.body'), body), field(t('workbench.base'), base), field(t('workbench.head'), head), button(t('workbench.pr'), async () => {
      if (!await confirmModal(t('workbench.pr'), `${status.repository}\n${head.value} → ${base.value}\n${title.value}\n${t('workbench.confirmPr')}`, t('workbench.pr'))) return;
      const created = await request<{ url: string }>('/api/git/pr', { ...ids, title: title.value, body: body.value, base: base.value, head: head.value, confirmed: true });
      result.append(openLink(t('github.open'), created.url));
    }));
  });
  panel.append(el('h3', '', t('workbench.prStatus')), el('p', '', t('github.manual')), row(refresh), result);
  return panel;
}
