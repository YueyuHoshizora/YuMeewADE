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
