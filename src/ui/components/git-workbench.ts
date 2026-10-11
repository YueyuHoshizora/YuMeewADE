import type { EditorDocument, GitWorkbenchStatus, GitPullRequestStatus, GitFileDiff, GitConflictView } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, confirmModal, el, field, input, link, modal, row, select, toast, type ViewContext } from './dom.ts';
import { taskComparisonButton } from './task-comparison.ts';

export function gitWorkbenchButton(context: ViewContext, project: string, task?: string): HTMLElement {
  return button(t('workbench.title'), async () => {
    const ids = { project, ...(task ? { task } : {}) };
    const panel = el('div', 'form');
    const mutate = async (action: string, values: Record<string, unknown> = {}) => {
      const result = await request<{ url?: string }>(`/api/git/${action}`, { ...ids, ...values });
      await refresh(); await context.refresh(); return result;
    };
    const viewDiff = async (path: string, staged: boolean) => {
      const diff = await request<GitFileDiff>(query('/api/git/diff', { ...ids, path, staged: String(staged) }));
      const content = el('div', 'form'); const selected = new Set<number>();
      for (const hunk of diff.hunks) {
        const block = el('section'); const checks: HTMLInputElement[] = [];
        block.append(el('h4', '', `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`));
        for (const line of hunk.lines) {
          const code = el('pre', '', `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`);
          if (diff.selectable && line.kind !== 'context') {
            const check = input(); check.type = 'checkbox'; check.setAttribute('aria-label', `${t('gitPrecision.line')} ${line.id + 1}`);
            check.addEventListener('change', () => { if (check.checked) selected.add(line.id); else selected.delete(line.id); });
            checks.push(check); block.append(row(check, code));
          } else block.append(code);
        }
        if (checks.length) block.prepend(button(t('gitPrecision.hunk'), () => { for (const check of checks) { check.checked = true; check.dispatchEvent(new Event('change')); } }));
        content.append(block);
      }
      if (!diff.hunks.length) content.append(el('pre', '', diff.patch || t('gitPrecision.noDiff')));
      if (!diff.selectable) content.append(el('p', '', t('gitPrecision.wholeFile')));
      const apply = button(t(staged ? 'workbench.unstage' : 'workbench.stage'), async () => {
        await mutate('stage-lines', { path, staged, fingerprint: diff.fingerprint, lines: [...selected] });
        content.closest('dialog')?.close();
      });
      apply.disabled = !diff.selectable;
      modal(`${t(staged ? 'gitPrecision.reverseDiff' : 'gitPrecision.diff')}: ${path}`, content, apply);
    };
    const refresh = async () => {
      const state = await request<GitWorkbenchStatus>(query('/api/git/status', ids));
      panel.replaceChildren(el('p', '', `${t(state.location === 'main' ? 'workbench.main' : 'workbench.task')}: ${state.root}`), el('p', '', `${t('workbench.branch')}: ${state.branch}`), el('p', '', `${t('workbench.upstream')}: ${state.upstream ?? '—'} / ${state.ahead} / ${state.behind}`), button(t('workbench.refresh'), refresh));
      for (const [title, files] of [
        ['workbench.conflicts', state.files.filter(file => file.conflict)],
        ['workbench.staged', state.files.filter(file => file.staged)],
        ['workbench.unstaged', state.files.filter(file => file.unstaged)],
        ['workbench.untracked', state.files.filter(file => file.untracked)],
      ] as const) {
        const group = el('section'); group.append(el('h3', '', t(title)));
        for (const file of files) {
          const actions = row(el('code', '', `${file.index}${file.working} ${file.path}`));
          if (file.secret) {
            actions.append(el('span', '', t('workbench.secret')));
            if (file.staged) actions.append(button(t('workbench.unstage'), () => mutate('unstage', { path: file.path })));
          }
          else if (file.conflict) actions.append(button(t('workbench.edit'), async () => {
            const conflict = await request<GitConflictView>(query('/api/git/conflict', { ...ids, path: file.path }));
            const versions = el('div', 'form');
            for (const [label, value] of [['gitPrecision.base', conflict.base], ['gitPrecision.ours', conflict.ours], ['gitPrecision.theirs', conflict.theirs]] as const) {
              const text = area(value ?? t('gitPrecision.absent')); text.readOnly = true; text.rows = 8;
              versions.append(field(t(label), text));
            }
            const edit = button(t('workbench.edit'), async () => {
              let document = await request<EditorDocument>(query('/api/editor/file', { ...ids, path: file.path }));
              if (document.binary || document.truncated) { toast(t('detail.editor_readonly')); return; }
              const text = area(document.text); text.rows = 22;
              const save = button(t('workbench.resolve'), async () => {
                document = await request<EditorDocument>('/api/editor/save', { ...ids, path: file.path, text: text.value, revision: document.revision });
                await mutate('resolve', { path: file.path });
                text.closest('dialog')?.close(); versions.closest('dialog')?.close();
              });
              modal(`${t('workbench.edit')}: ${file.path}`, field(file.path, text), save);
            });
            modal(`${t('workbench.edit')}: ${file.path}`, versions, edit, button(t('gitPrecision.resolveCurrent'), async () => {
              await mutate('resolve', { path: file.path }); versions.closest('dialog')?.close();
            }));
          }));
          else actions.append(button(t(title === 'workbench.staged' ? 'workbench.unstage' : 'workbench.stage'), () => mutate(title === 'workbench.staged' ? 'unstage' : 'stage', { path: file.path })));
          if (!file.secret && !file.conflict) actions.append(button(t('gitPrecision.diff'), () => viewDiff(file.path, title === 'workbench.staged')));
          group.append(actions);
        }
        panel.append(group);
      }
      const historyPath = input(); const commitSha = input();
      const history = async (skip = 0) => {
        const result = await request<{ graph: string; next: number | null }>(query('/api/git/history', { ...ids, skip: String(skip), ...(historyPath.value ? { path: historyPath.value } : {}) }));
        const view = el('div', 'form'); view.append(el('pre', '', result.graph));
        for (const sha of new Set(result.graph.match(/[a-f0-9]{40,64}/g) ?? [])) view.append(button(sha.slice(0, 12), () => detail(sha)));
        if (result.next !== null) view.append(button(t('gitManage.next'), () => history(result.next!)));
        modal(t('gitManage.history'), view);
      };
      const detail = async (sha: string) => {
        const result = await request<{ metadata: string; files: string[]; patch: string }>(query('/api/git/commit-detail', { ...ids, sha }));
        const view = el('div', 'form'); view.append(el('pre', '', result.metadata), el('pre', '', result.patch));
        for (const path of result.files) view.append(button(path, () => window.dispatchEvent(new CustomEvent('yumeewade:open-file', { detail: { project, task: task ?? '', path } }))));
        modal(t('gitManage.detail'), view);
      };
      panel.append(field(t('gitManage.path'), historyPath), row(button(t('gitManage.history'), () => history()), button(t('gitManage.blame'), async () => {
        const result = await request<{ text: string }>(query('/api/git/blame', { ...ids, path: historyPath.value }));
        modal(t('gitManage.blame'), el('pre', '', result.text));
      })), field(t('gitManage.sha'), commitSha), button(t('gitManage.detail'), () => detail(commitSha.value)));
      const stashMessage = input(); const untracked = input(); untracked.type = 'checkbox';
      panel.append(field(t('gitManage.stashMessage'), stashMessage), field(t('gitManage.untracked'), untracked), button(t('gitManage.stashPush'), () => mutate('stash', { action: 'push', message: stashMessage.value, includeUntracked: untracked.checked })));
      for (const entry of await request<Array<{ sha: string; ref: string; message: string }>>(query('/api/git/stashes', ids))) {
        const actions = row(el('code', '', `${entry.ref} ${entry.message}`));
        for (const action of ['apply', 'pop', 'drop'] as const) actions.append(button(t(`gitManage.${action}`), async () => {
          if (action === 'drop' && !await confirmModal(t('gitManage.drop'), entry.message, t('gitManage.drop'))) return;
          await mutate('stash', { action, sha: entry.sha, confirmed: true });
        }));
        panel.append(actions);
      }
      const rewriteTarget = input();
      panel.append(field(t('gitManage.rewriteTarget'), rewriteTarget));
      for (const action of ['cherry-pick', 'rebase', 'continue', 'abort'] as const) panel.append(button(t(`gitManage.${action}`), async () => {
        if (await confirmModal(t(`gitManage.${action}`), `${state.branch} → ${rewriteTarget.value}\n${t('gitManage.rewriteConfirm')}`, t(`gitManage.${action}`))) await mutate('rewrite', { action, target: rewriteTarget.value, confirmed: true });
      }));
      const message = area(); message.maxLength = 10_000;
      panel.append(field(t('workbench.message'), message), row(button(t('workbench.commit'), () => mutate('commit', { message: message.value })), button(t('gitPrecision.bypass'), async () => {
        if (await confirmModal(t('gitPrecision.bypass'), t('gitPrecision.confirmBypass'), t('workbench.commit'))) await mutate('commit', { message: message.value, bypassHooks: true, confirmed: true });
      })), taskComparisonButton(project));
      const branch = input(); branch.maxLength = 200;
      const existing = select(state.branches.map(name => ({ value: name, label: name })), state.branch);
      panel.append(field(t('workbench.branch'), branch), row(button(t('workbench.create'), () => mutate('branch', { name: branch.value, create: true })), existing, button(t('workbench.switch'), () => mutate('branch', { name: existing.value, create: false }))));
      const remote = select(state.remotes.map(name => ({ value: name, label: name })), state.remotes[0]);
      panel.append(field(t('workbench.remote'), remote), row(button(t('workbench.fetch'), () => mutate('fetch', { remote: remote.value })), button(t('workbench.push'), async () => {
        if (await confirmModal(t('workbench.push'), `${state.root}\n${state.branch} → ${remote.value}\n${t('workbench.confirmPush')}`, t('workbench.push'))) await mutate('push', { remote: remote.value, confirmed: true });
      })));
      const prStatus = await request<GitPullRequestStatus>(query('/api/git/pr-status', ids));
      panel.append(el('p', '', `${t('workbench.prStatus')}: ${prStatus.available ? '✓' : '✗'} / ${prStatus.authenticated ? '✓' : '✗'} / ${prStatus.repository ?? '—'}`));
      const title = input(); const body = area(); const base = input('main'); const head = input(state.branch);
      title.maxLength = 300; body.maxLength = 60_000;
      const createPr = button(t('workbench.pr'), async () => {
        if (!(await confirmModal(t('workbench.pr'), `${prStatus.repository}\n${head.value} → ${base.value}\n${title.value}\n${t('workbench.confirmPr')}`, t('workbench.pr')))) return;
        const result = await mutate('pr', { title: title.value, body: body.value, base: base.value, head: head.value, confirmed: true });
        if (result.url) { const anchor = link(result.url, result.url); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; panel.append(anchor); }
      });
      createPr.disabled = !prStatus.available || !prStatus.authenticated || !prStatus.repository;
      panel.append(field(t('common.title'), title), field(t('workbench.body'), body), field(t('workbench.base'), base), field(t('workbench.head'), head), createPr);
    };
    await refresh(); modal(t('workbench.title'), panel);
  });
}
