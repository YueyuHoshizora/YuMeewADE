import type { GithubIssue, Task } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, el, field, input, link, modal, row, storeLocal, taskHash, type ViewContext } from './dom.ts';

export function githubIssuesButton(context: ViewContext, project: string): HTMLElement {
  return button(t('github.issues'), () => {
    const search = input(); search.maxLength = 300; const results = el('div', 'form');
    const fetchIssues = button(t('github.search'), async () => {
      const issues = await request<GithubIssue[]>(query('/api/git/issues', { project, ...(search.value.trim() ? { search: search.value.trim() } : {}) }));
      results.replaceChildren();
      if (!issues.length) results.append(el('p', '', t('common.empty')));
      for (const issue of issues) results.append(button(`#${issue.number} ${issue.title}`, async () => {
        const detail = await request<GithubIssue>(query('/api/git/issue', { project, number: String(issue.number) }));
        const title = input(detail.title); title.maxLength = 300;
        const instruction = area(`${detail.title}\n${detail.url}\n\n${detail.body}`.slice(0, context.state.limits.promptChars)); instruction.maxLength = context.state.limits.promptChars; instruction.rows = 12;
        const content = el('div', 'form'); const anchor = link(t('github.open'), detail.url); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
        content.append(anchor, el('pre', '', detail.body), field(t('common.title'), title), field(t('github.instruction'), instruction));
        modal(`#${detail.number}`, content, button(t('github.createTask'), async () => {
          const result = await request<{ task: Task }>('/api/git/issue-task', { project, number: detail.number, title: title.value, draft: instruction.value });
          storeLocal(`yumeewade.draft.${project}/${result.task.id}`, instruction.value);
          content.closest('dialog')?.close(); results.closest('dialog')?.close();
          await context.refresh(); location.hash = taskHash(project, result.task.id);
        }));
      }));
    });
    const panel = el('div', 'form'); panel.append(el('p', '', t('github.manual')), row(search, fetchIssues), results);
    modal(t('github.issues'), panel);
  });
}
