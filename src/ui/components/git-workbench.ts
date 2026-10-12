import type { BlameLine, EditorDocument, GitWorkbenchStatus, GitFileDiff, GitConflictView, GitRemote, WorktreeMaintenanceEntry } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { labelValue, t } from '../i18n/index.ts';
import { localDateTime } from './display.ts';
import { area, button, confirmModal, el, field, input, modal, row, select, toast, type ViewContext } from './dom.ts';
import { taskComparisonButton } from './task-comparison.ts';
import { githubPullRequestPanel } from './github.ts';
import { sideDiff } from './side-diff.ts';

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
      modal(labelValue(t(staged ? 'gitPrecision.reverseDiff' : 'gitPrecision.diff'), path), sideDiff(content, { ...ids, path, mode: staged ? 'staged' : 'working' }), apply);
    };
    const refresh = async () => {
      const state = await request<GitWorkbenchStatus>(query('/api/git/status', ids));
      panel.replaceChildren(el('p', '', labelValue(t(state.location === 'main' ? 'workbench.main' : 'workbench.task'), state.root)), el('p', '', labelValue(t('workbench.branch'), state.branch)), el('p', '', `${labelValue(t('workbench.upstream'), state.upstream ?? '—')} / ${state.ahead} / ${state.behind}`), button(t('workbench.refresh'), refresh));
      panel.append(button(t('worktrees.title'), async () => {
        const content = el('div', 'form');
        const reload = async () => {
          content.replaceChildren(el('p', '', t('worktrees.leaveDirty')));
          for (const entry of await request<WorktreeMaintenanceEntry[]>(query('/api/git/worktrees', { project }))) {
            const item = el('div', 'form');
            item.append(el('p', '', `${entry.path} — ${entry.branch || '—'} — ${t(`worktrees.${entry.kind}`)} — ${t(entry.dirty === null ? 'worktrees.missing' : entry.dirty ? 'worktrees.dirty' : 'worktrees.clean')}${entry.locked ? ` — ${t('worktrees.locked')}` : ''}${entry.prunable ? ` — ${t('worktrees.prunable')}` : ''}`));
            if (entry.removable) item.append(button(t('worktrees.remove'), async () => {
              if (!await confirmModal(t('worktrees.remove'), entry.path, t('worktrees.remove'))) return;
              await request('/api/git/worktrees/remove', { project, path: entry.path, confirmed: true });
              await reload(); await context.refresh();
            }));
            content.append(item);
          }
          content.append(button(t('worktrees.prune'), async () => {
            const { preview } = await request<{ preview: string }>(query('/api/git/worktrees/prune-preview', { project }));
            if (!preview.trim()) { toast(t('worktrees.noPrune')); return; }
            if (!await confirmModal(t('worktrees.prune'), preview, t('worktrees.prune'))) return;
            await request('/api/git/worktrees/prune', { project, preview, confirmed: true });
            await reload(); await context.refresh();
          }));
        };
        await reload(); modal(t('worktrees.title'), content);
      }));
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
              modal(labelValue(t('workbench.edit'), file.path), field(file.path, text), save);
            });
            modal(labelValue(t('workbench.edit'), file.path), versions, edit, button(t('gitPrecision.resolveCurrent'), async () => {
              await mutate('resolve', { path: file.path }); versions.closest('dialog')?.close();
            }));
          }));
          else actions.append(button(t(title === 'workbench.staged' ? 'workbench.unstage' : 'workbench.stage'), () => mutate(title === 'workbench.staged' ? 'unstage' : 'stage', { path: file.path })));
          if (!file.secret && !file.conflict) actions.append(button(t('gitPrecision.diff'), () => viewDiff(file.path, title === 'workbench.staged')));
          if ((title === 'workbench.unstaged' || title === 'workbench.untracked') && !file.secret && !file.conflict && !file.originalPath) actions.append(button(t('workbench.discard'), async () => {
            // The fingerprint binds the discard to the content shown when confirming; a later edit makes the server refuse.
            const diff = await request<GitFileDiff>(query('/api/git/diff', { ...ids, path: file.path, staged: 'false' }));
            if (!diff.fingerprint) { toast(t('workbench.discardTooLarge')); return; }
            if (!await confirmModal(t('workbench.discard'), t(file.untracked ? 'workbench.discardUntracked' : 'workbench.discardConfirm', { path: file.path }), t('workbench.discard'))) return;
            await mutate('discard', { path: file.path, fingerprint: diff.fingerprint });
          }, 'danger'));
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
      const openFile = (path: string, line?: number) => window.dispatchEvent(new CustomEvent('yumeewade:open-file', { detail: { project, task: task ?? '', path, ...(line ? { line } : {}) } }));
      const blame = async () => {
        const path = historyPath.value;
        const { lines } = await request<{ lines: BlameLine[] }>(query('/api/git/blame', { ...ids, path }));
        const table = el('table', 'git-blame'); const head = el('tr'); const body = el('tbody');
        for (const key of ['gitBlame.commit', 'gitBlame.author', 'gitBlame.date', 'gitBlame.line', 'gitBlame.content'] as const) head.append(el('th', '', t(key)));
        const thead = el('thead'); thead.append(head); table.append(thead, body);
        // Like IDE gutters, only the first line of a run from the same commit repeats its metadata.
        let previous = '';
        for (const entry of lines) {
          const commit = el('td'); const author = el('td'); const date = el('td');
          if (entry.sha !== previous) {
            if (entry.committed) {
              const open = button(entry.sha.slice(0, 8), () => detail(entry.sha), 'subtle'); open.title = entry.summary; commit.append(open);
              author.textContent = entry.author; date.textContent = entry.time ? localDateTime(entry.time) : '';
            } else commit.textContent = t('gitBlame.uncommitted');
          }
          previous = entry.sha;
          const line = el('td'); line.append(button(String(entry.line), () => openFile(path, entry.line), 'subtle'));
          const text = el('td'); text.append(el('code', '', entry.text));
          const item = el('tr'); item.append(commit, author, date, line, text); body.append(item);
        }
        modal(labelValue(t('gitManage.blame'), path), table);
      };
      panel.append(field(t('gitManage.path'), historyPath), row(button(t('gitManage.history'), () => history()), button(t('gitManage.blame'), blame)), field(t('gitManage.sha'), commitSha), button(t('gitManage.detail'), () => detail(commitSha.value)));
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
      const existing = select(state.branches.map(name => ({ value: name, label: name })), state.branch); existing.setAttribute('aria-label', t('workbench.branch'));
      panel.append(field(t('workbench.branch'), branch), row(button(t('workbench.create'), () => mutate('branch', { name: branch.value, create: true })), existing, button(t('workbench.switch'), () => mutate('branch', { name: existing.value, create: false }))));
      panel.append(row(button(t('gitRemote.rename'), () => mutate('manage-branch', { action: 'rename', name: existing.value, newName: branch.value })), ...[false, true].map(force => button(t(force ? 'gitRemote.force' : 'gitRemote.delete'), async () => {
        if (!await confirmModal(t('gitRemote.delete'), existing.value, t('gitRemote.delete'))) return;
        if (force && !await confirmModal(t('gitRemote.force'), `${existing.value}\n${t('gitRemote.forceConfirm')}`, t('gitRemote.force'))) return;
        await mutate('manage-branch', { action: 'delete', name: existing.value, force, confirmed: true, forceConfirmed: force });
      }))));
      const remoteName = input(); remoteName.maxLength = 100;
      const remoteUrl = input(); remoteUrl.maxLength = 2048;
      panel.append(field(t('workbench.remote'), remoteName), field(t('gitRemote.url'), remoteUrl), button(t('gitRemote.add'), () => mutate('remote', { action: 'add', name: remoteName.value, url: remoteUrl.value })));
      for (const entry of await request<GitRemote[]>(query('/api/git/remotes', ids))) {
        const newName = input(entry.name); newName.maxLength = 100;
        const fetchUrl = input(entry.fetchUrls[0] ?? ''); fetchUrl.maxLength = 2048;
        const pushUrl = input(entry.pushUrls[0] ?? ''); pushUrl.maxLength = 2048;
        const group = el('section', 'form');
        group.append(el('h3', '', entry.name), el('pre', '', `${labelValue(t('gitRemote.fetchUrl'), entry.fetchUrls.join('\n'))}\n${labelValue(t('gitRemote.pushUrl'), entry.pushUrls.join('\n'))}`), field(t('workbench.remote'), newName), button(t('gitRemote.rename'), () => mutate('remote', { action: 'rename', name: entry.name, newName: newName.value })), field(t('gitRemote.fetchUrl'), fetchUrl), button(t('gitRemote.setUrl'), () => mutate('remote', { action: 'set-url', name: entry.name, url: fetchUrl.value })), field(t('gitRemote.pushUrl'), pushUrl), button(t('gitRemote.setUrl'), () => mutate('remote', { action: 'set-url', name: entry.name, url: pushUrl.value, push: true })), button(t('gitRemote.remove'), async () => {
          if (await confirmModal(t('gitRemote.remove'), entry.name, t('gitRemote.remove'))) await mutate('remote', { action: 'remove', name: entry.name, confirmed: true });
        }));
        panel.append(group);
      }
      const remote = select(state.remotes.map(name => ({ value: name, label: name })), state.remotes[0]);
      panel.append(field(t('workbench.remote'), remote), row(button(t('workbench.fetch'), () => mutate('fetch', { remote: remote.value })), button(t('workbench.push'), async () => {
        if (await confirmModal(t('workbench.push'), `${state.root}\n${state.branch} → ${remote.value}\n${t('workbench.confirmPush')}`, t('workbench.push'))) await mutate('push', { remote: remote.value, confirmed: true });
      })));
      panel.append(githubPullRequestPanel(project, task, state.branch, context));
    };
    await refresh(); modal(t('workbench.title'), panel);
  });
}
