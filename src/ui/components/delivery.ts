import type { GitFileDiff, GitWorkbenchStatus, ProjectView, TaskSections, TaskView, VerificationHistoryEntry, VerifyStatus } from '../../shared/types.ts';
import { api, query, request } from '../api.ts';
import { getLocale, t } from '../i18n/index.ts';
import { button, el, errorMessage, field, input, row, setLocked, taskHash, type ViewContext } from './dom.ts';
import { readonlyDiffView, verificationStatusView } from './verification-view.ts';

export interface DeliveryReview {
  /** Relevant task, workspace, verification configuration or execution changes invalidate the snapshot. */
  update(): void;
  dispose(): void;
}

/** Evidence is fetched only after explicit entry into review; completion remains a human decision, not a merge gate. */
export function openDeliveryReview(context: ViewContext, initialProject: ProjectView, initialTask: TaskView, options: { viewDiff?: () => unknown } = {}): DeliveryReview {
  const ids = { project: initialProject.id, task: initialTask.id };
  const dialog = el('dialog', 'modal delivery-review');
  dialog.setAttribute('aria-label', t('delivery.review'));
  const content = el('div');
  const acknowledgement = input(); acknowledgement.type = 'checkbox';
  let alive = true;
  let serial = 0;
  let ready = false;
  let submitting = false;
  let diffSerial = 0;
  let fingerprint = '';
  function evidenceFingerprint(): string {
    const snapshot = current();
    return JSON.stringify([context.state.root, snapshot?.task, snapshot?.project.bodyPath, snapshot?.project.bodyMissing,
      snapshot?.project.verify, snapshot?.project.checks, snapshot?.project.requireVerification, snapshot?.project.verificationInputs,
      context.state.running.filter(item => item.project === ids.project && item.task === ids.task)]);
  }
  function current(): { project: ProjectView; task: TaskView } | null {
    const project = context.state.projects.find(item => item.id === ids.project);
    const task = project?.tasks.find(item => item.id === ids.task);
    return project && task ? { project, task } : null;
  }
  function lock(): void {
    setLocked(approve, !ready || !current()?.task.confirm || !acknowledgement.checked || submitting || context.state.running.some(item => item.project === ids.project && item.task === ids.task));
    setLocked(continueButton, !ready || !current()?.task.confirm || submitting);
    setLocked(refresh, submitting);
    acknowledgement.disabled = !ready || submitting || !current()?.task.confirm || context.state.running.some(item => item.project === ids.project && item.task === ids.task);
  }
  async function complete(action: 'approve' | 'continue'): Promise<void> {
    if (!alive || !ready || submitting || action === 'approve' && !acknowledgement.checked) return;
    const snapshot = current();
    if (fingerprint !== evidenceFingerprint()) { invalidate(); return; }
    if (!snapshot?.task.confirm) { invalidate(); return; }
    if (action === 'approve' && context.state.running.some(item => item.project === ids.project && item.task === ids.task)) { invalidate(); return; }
    submitting = true; lock();
    try {
      await request('/api/task/completion', { ...ids, action });
      dispose();
      await context.refresh();
    } finally { submitting = false; lock(); }
  }
  const approve = button(t('turn.approve'), () => complete('approve'), 'primary');
  const continueButton = button(t('turn.continue'), () => complete('continue'));
  const refresh = button(t('delivery.refresh'), load);
  acknowledgement.onchange = lock;
  function dispose(): void {
    if (!alive) return;
    alive = false; serial++; diffSerial++;
    dialog.close(); dialog.remove();
  }
  function invalidate(): void {
    if (!alive) return;
    serial++; diffSerial++; ready = false; acknowledgement.checked = false;
    if (!current()) { dispose(); return; }
    content.replaceChildren(el('p', 'warning', t('delivery.stale')));
    lock();
  }
  function failure(target: HTMLElement, error: unknown): void {
    target.append(el('p', 'warning', t('delivery.unavailable')), el('p', 'error-mark', errorMessage(error)));
  }
  function textList(target: HTMLElement, title: string, values: string[]): void {
    target.append(el('h3', '', title));
    if (!values.length) { target.append(el('p', 'muted', t('common.none'))); return; }
    const list = el('ul');
    for (const value of values.slice(0, 200)) list.append(el('li', '', value));
    target.append(list);
    if (values.length > 200) target.append(el('p', 'muted', t('delivery.more', { n: values.length - 200 })));
  }
  /** Record sections with content keep their heading and list; empty ones are named together on one line instead of a "none" each. */
  function textLists(target: HTMLElement, sections: [title: string, values: string[]][]): void {
    const empty: string[] = [];
    for (const [title, values] of sections) { if (values.length) textList(target, title, values); else empty.push(title); }
    if (empty.length) target.append(el('p', 'muted', t('delivery.emptySections', { list: new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(empty) })));
  }
  async function load(): Promise<void> {
    if (!alive || submitting) return;
    const snapshot = current();
    if (!snapshot) { dispose(); return; }
    const { project, task } = snapshot;
    fingerprint = evidenceFingerprint();
    const revision = ++serial; diffSerial++;
    ready = false; acknowledgement.checked = false; lock();
    const scope = el('section', 'card');
    const verification = el('section', 'card');
    const claims = el('section', 'card');
    scope.append(el('h3', '', t('delivery.scope')), el('p', 'muted', t('delivery.loading')));
    verification.append(el('h3', '', t('delivery.machine')), el('p', 'muted', t('delivery.loading')));
    claims.append(el('h3', '', t('delivery.claims')), el('p', 'muted', t('delivery.loading')));
    content.replaceChildren(el('h3', '', task.title), scope, verification, claims);
    const active = () => alive && serial === revision;
    const jobs: Promise<void>[] = [];
    jobs.push((async () => {
      try {
        const sections = await request<TaskSections>(query('/api/task/sections', ids));
        if (!active()) return;
        claims.replaceChildren(el('h3', '', t('delivery.claims')), el('p', 'muted', t('delivery.claimHint')));
        textLists(claims, [
          [t('tasks.doneSection'), sections.done],
          [t('delivery.unfinished'), task.steps.filter(step => !step.done).map(step => step.text)],
          [t('tasks.next'), sections.next],
          [t('tasks.cautions'), sections.cautions],
        ]);
      } catch (error) { if (active()) { claims.replaceChildren(el('h3', '', t('delivery.claims'))); failure(claims, error); } }
    })());
    jobs.push((async () => {
      try {
        const status = await request<VerifyStatus | null>(query('/api/task/verify', ids));
        const history = status ? [] : await request<VerificationHistoryEntry[]>(query('/api/task/verify/history', ids));
        if (!active()) return;
        verification.replaceChildren(el('h3', '', t('delivery.machine')));
        if (!project.verify?.trim() && !project.checks?.length) verification.append(el('p', 'warning', t('delivery.unconfigured')));
        if (status) verification.append(...verificationStatusView(status));
        else verification.append(el('p', 'warning', t(history.length ? 'delivery.invalid' : 'delivery.notRun')));
      } catch (error) { if (active()) { verification.replaceChildren(el('h3', '', t('delivery.machine'))); failure(verification, error); } }
    })());
    jobs.push((async () => {
      scope.replaceChildren(el('h3', '', t('delivery.scope')));
      if (task.copyMissing) { scope.append(el('p', 'warning', t('copy.missing'))); return; }
      if (task.workspace !== 'direct' && !task.copy) { scope.append(el('p', 'warning', t('git.noCopy')), el('p', 'muted', t('delivery.noScope'))); return; }
      if (task.workspace !== 'direct' && task.mergeExcluded) { scope.append(el('p', 'warning', t('copy.excluded')), el('p', 'muted', t('delivery.noScope'))); return; }
      scope.append(el('p', 'muted', t('delivery.loading')));
      try {
        if (task.workspace === 'direct') {
          const status = await request<GitWorkbenchStatus>(query('/api/git/status', ids));
          if (!active()) return;
          scope.replaceChildren(el('h3', '', t('delivery.scope')), el('p', 'warning', t('delivery.direct')));
          textList(scope, t('git.branch'), [status.branch]);
          scope.append(el('h3', '', t('git.files', { n: status.files.length })));
          const files = el('ul');
          const diff = el('div');
          for (const file of status.files.slice(0, 200)) {
            const item = el('li');
            item.append(el('code', '', `${file.index}${file.working} ${file.path}`));
            if (file.secret) item.append(el('span', 'warning', t('workbench.secret')));
            else {
              for (const staged of [false, true]) {
                if (staged ? !file.staged : !file.unstaged && !file.untracked && !file.conflict) continue;
                item.append(button(t(staged ? 'workbench.staged' : 'workbench.unstaged'), async () => {
                  const requestSerial = ++diffSerial;
                  diff.replaceChildren(el('p', 'muted', t('delivery.loading')));
                  try {
                    const result = await request<GitFileDiff>(query('/api/git/diff', { ...ids, path: file.path, staged: String(staged) }));
                    if (!active() || requestSerial !== diffSerial) return;
                    diff.replaceChildren(el('h4', '', result.path));
                    if (staged) diff.append(el('p', 'warning', t('delivery.stagedReverse')));
                    diff.append(readonlyDiffView({ diff: result.patch, truncated: !!result.truncated }));
                  } catch (error) { if (active() && requestSerial === diffSerial) { diff.replaceChildren(); failure(diff, error); } }
                }));
              }
            }
            files.append(item);
          }
          scope.append(files);
          if (status.files.length > 200) scope.append(el('p', 'muted', t('git.moreFiles', { n: status.files.length - 200 })));
          scope.append(diff);
          const conflicts = status.files.filter(file => file.conflict).map(file => file.path);
          if (conflicts.length) textList(scope, t('copy.conflict'), conflicts);
        } else {
          const preview = await api.preview(ids.project, ids.task);
          if (!active()) return;
          scope.replaceChildren(el('h3', '', t('delivery.scope')));
          if (!preview) { scope.append(el('p', 'warning', t('delivery.noScope'))); return; }
          scope.append(el('p', '', t('copy.stats', { files: preview.files, added: preview.added, removed: preview.removed })), el('p', 'muted', `${preview.branch} → ${preview.target}`));
          textList(scope, t('git.files', { n: preview.paths.length }), preview.paths);
          if (preview.conflict) textList(scope, t('copy.conflict'), preview.conflictPaths);
          if (preview.overlaps.length) textList(scope, t('git.overlap', { n: preview.overlaps.length }), preview.overlaps.map(item => `${item.title}: ${item.paths.join(', ')}`));
          if (preview.mainDirty) scope.append(el('p', 'warning', t('copy.mainDirty')));
          const diff = el('div');
          scope.append(button(t('copy.diff'), async () => {
            const requestSerial = ++diffSerial;
            diff.replaceChildren(el('p', 'muted', t('delivery.loading')));
            try {
              const result = await api.diff(ids.project, ids.task);
              if (active() && requestSerial === diffSerial) diff.replaceChildren(readonlyDiffView(result));
            } catch (error) { if (active() && requestSerial === diffSerial) { diff.replaceChildren(); failure(diff, error); } }
          }), diff);
        }
      } catch (error) { if (active()) { scope.replaceChildren(el('h3', '', t('delivery.scope'))); failure(scope, error); } }
    })());
    await Promise.all(jobs);
    if (!active()) return;
    if (fingerprint !== evidenceFingerprint()) { invalidate(); return; }
    ready = true; lock();
  }
  dialog.append(row(el('h2', '', t('delivery.review')), button(t('common.close'), dispose)), content,
    el('p', 'warning', t('delivery.manual')), field(t('delivery.acknowledge'), acknowledgement),
    row(refresh, button(t('delivery.openTask'), () => {
      dispose();
      if (options.viewDiff) return options.viewDiff();
      location.hash = `${taskHash(ids.project, ids.task)}?panel=review`;
    }), continueButton, approve));
  dialog.addEventListener('cancel', event => { event.preventDefault(); dispose(); });
  dialog.addEventListener('close', dispose);
  document.body.append(dialog); dialog.showModal();
  lock(); void load();
  return { update: () => { if (fingerprint !== evidenceFingerprint()) invalidate(); }, dispose };
}
