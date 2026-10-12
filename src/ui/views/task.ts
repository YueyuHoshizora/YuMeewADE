import { metadataEditor } from '../components/task-metadata.ts';
import type {
  AppState, Busy, ChatEvent, ChatHistory, ChatRow, ProjectView,
  QueueItem, SendMode, SlashCommand, Task, TaskSections, TaskView, VerifyResult, VerifyStatus,
} from '../../shared/types.ts';
import { TASK_STATES } from '../../shared/types.ts';
import { api, query, request } from '../api.ts';
import { getLocale, labelValue, t } from '../i18n/index.ts';
import { attachments } from '../components/attachments.ts';
import { aiPicker } from '../components/picker.ts';
import { copyText, markdown } from '../components/markdown.ts';
import { MarkdownStream } from '../components/markdown-stream.ts';
import { HistoryWindow } from '../components/history.ts';
import { TranscriptWindow, type WindowRow } from '../components/windowing.ts';
import {
  area, button, confirmModal, disclosure, el, field, iconButton, input, link, modal,
  projectHash, readLocal, row, run, select, statusRegion, storeLocal, taskHash, textModal, toast,
  type View, type ViewContext,
} from '../components/dom.ts';
import { aiLabel, effortLabel, localTime, modelLabel } from '../components/display.ts';
import { shouldSend } from '../components/composer.ts';
import { stream } from '../components/stream.ts';
import { parseDiff, type DiffLine } from '../components/diff.ts';
import { verificationSteps } from '../components/verification-view.ts';
import { sideDiff } from '../components/side-diff.ts';
import { buildReviewPrompt, type ReviewItem } from '../components/review.ts';
import { openFileBrowser } from '../components/editor-loader.ts';
import { attachComposeInsert, attachMention } from '../components/mention.ts';
import { snippetsButton } from '../components/snippet-menu.ts';
import { attachSlashCommands } from '../components/slash-menu.ts';
import { contextButton, contextManifestButton } from '../components/context.ts';
import { reviewButton } from '../components/review-button.ts';
import { renderPermissions } from '../components/permissions.ts';
import { reviewDrafts } from '../components/review-drafts.ts';
import { executionButton } from '../components/execution.ts';
import { gitWorkbenchButton } from '../components/git-workbench.ts';
import { workflowButton } from '../components/workflows.ts';
import { confirmUsageRound } from '../components/usage-history.ts';
import { projectTrustButton } from '../components/project-trust.ts';
import { testExplorerButton, verificationHistoryButton } from '../components/test-explorer.ts';
import { githubLinkedFeedbackPanel } from '../components/github-feedback.ts';

export function taskView(
  context: ViewContext,
  initialProject: ProjectView,
  initialTask: TaskView,
  params = new URLSearchParams(),
): View {
  let project = initialProject;
  let task = initialTask;
  let alive = true;
  let rows: ChatRow[] = [];
  const history = new HistoryWindow();
  let loadingHistory: Promise<void> | null = null;
  const requestedIndex = params.has('index') ? Number(params.get('index')) : -1;
  let focusIndex = Number.isSafeInteger(requestedIndex) && requestedIndex >= 0 ? requestedIndex : -1;
  async function focusHistory(): Promise<void> {
    if (focusIndex < 0) return;
    following = false;
    const revision = history.revision;
    while (alive && revision === history.revision && history.start > focusIndex) {
      const before = history.start;
      await loadEarlier();
      if (history.start === before) return;
    }
    if (!alive || revision !== history.revision) return;
    virtual.reveal(unitKey(focusIndex));
    const target = transcriptRows.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`);
    if (!target) return;
    target.closest('details')?.setAttribute('open', '');
    target.scrollIntoView({ block: 'center' });
    target.classList.add('search-highlight');
    focusIndex = -1;
    window.setTimeout(() => target.classList.remove('search-highlight'), 2500);
  }
  let busy: Busy | null = null;
  let partial = '';
  let queue: QueueItem[] = [];
  let following = true;
  const node = el('div', 'task-page');
  const header = el('header', 'task-header');
  const work = el('div', 'work-info');
  const title = input(task.title);
  title.className = 'title-input';
  title.maxLength = 80;
  title.setAttribute('aria-label', t('task.titleEdit'));
  title.onchange = () => {
    void run(async () => {
      await request('/api/task/update', { project: project.id, task: task.id, patch: { title: title.value.trim() } });
      await context.refresh();
    });
  };
  const stateChip = el('span', 'state-chip', t(`state.${task.state}`));
  let verifying = false;
  const verifyButton = button(t('verify.run'), async () => {
    if (busy || verifying) return;
    verifying = true;
    updateHeaderActions();
    try {
      const result = await request<VerifyResult>('/api/task/verify', { project: project.id, task: task.id });
      if (!alive) return;
      modal(t('verify.run'),
        el('strong', result.ok && !result.drifted ? 'verify-pass' : 'error-mark', t(result.ok && !result.drifted ? 'verify.pass' : 'verify.fail')),
        el('p', '', t('verify.result', { code: result.exitCode ?? t('common.none'), seconds: (result.ms / 1000).toFixed(1) })),
        ...(result.timedOut ? [el('p', 'warning', t('verify.timedOut'))] : []),
        ...(result.truncated ? [el('p', 'warning', t('verify.truncated'))] : []),
        el('pre', 'verify-output', result.output),
        ...(result.drifted ? [el('p', 'warning', t('verification.hint'))] : []),
        ...verificationSteps(result),
        ...(result.ok ? [] : [sendFix(result)]));
      await run(renderWork);
    } finally {
      verifying = false;
      updateHeaderActions();
    }
  });
  /** 驗證失敗時，把輸出尾段當成下一個指示交給 AI 修正。 */
  function sendFix(result: VerifyResult): HTMLButtonElement {
    const fix = button(t('verify.sendFix'), () => run(async () => {
      fix.closest('dialog')?.close();
      const output = result.output.length > 8000 ? result.output.slice(-8000) : result.output;
      await send(busy ? 'queue' : undefined, t('verify.fixPrompt', { code: result.exitCode ?? t('common.none'), output }));
    }), 'primary');
    return fix;
  }
  function hasVerification(): boolean {
    return !!project.verify?.trim() || !!project.checks?.length;
  }
  function updateHeaderActions(): void {
    verifyButton.hidden = !hasVerification() || !!busy;
    verifyButton.disabled = verifying;
    verifyButton.textContent = t(verifying ? 'verify.running' : 'verify.run');
    verifyButton.setAttribute('aria-busy', String(verifying));
    for (const retry of transcriptRows.querySelectorAll<HTMLButtonElement>('.retry-message')) retry.hidden = !!busy;
  }
  const gitPanelKey = 'yumeewade.gitPanel';
  // 第一次使用時，寬螢幕預設展開、窄螢幕預設收起；之後沿用使用者的選擇。
  let gitOpen = readLocal<boolean | null>(gitPanelKey, null) ?? window.matchMedia('(min-width: 1000px)').matches;
  const gitPanel = el('aside', 'git-panel');
  gitPanel.id = 'git-panel';
  gitPanel.setAttribute('aria-label', t('git.title'));
  const gitToggle = button('Git', () => setGitPanel(!gitOpen), 'git-toggle');
  gitToggle.setAttribute('aria-controls', 'git-panel');
  function setGitPanel(open: boolean, persist = true): void {
    gitOpen = open;
    if (persist) storeLocal(gitPanelKey, open);
    gitPanel.hidden = !open;
    gitToggle.setAttribute('aria-expanded', String(open));
    gitToggle.title = t(open ? 'git.hide' : 'git.show');
    gitToggle.classList.toggle('active', open);
  }
  function setGitBadge(changes = 0, conflict = false): void {
    gitToggle.textContent = changes ? `Git · ${changes}` : 'Git';
    gitToggle.classList.toggle('git-conflict', conflict);
  }
  const gitPanelHead = el('div', 'git-panel-head');
  gitPanelHead.append(el('h2', '', t('git.title')), iconButton('×', t('git.hide'), () => setGitPanel(false), 'subtle'));
  gitPanel.append(gitPanelHead, work);
  setGitPanel(gitOpen, false);
  const exportLink = link(t('chat.export'), query('/api/chat/export', { project: project.id, task: task.id }), 'export-chat');
  exportLink.download = `${task.title}.md`;
  header.append(
    link(t('common.back', { name: project.name }), projectHash(project.id), 'back-link'),
    row(
      title,
      stateChip,
      button(t('common.open'), () => request('/api/open', { path: task.workdir || project.bodyPath })),
      exportLink,
      verifyButton,
      testExplorerButton(project.id, task.id),
      verificationHistoryButton(project.id, task.id),
      button(t('files.open'), () => openFileBrowser(project.id, task.id)),
      executionButton(context, project.id, task.id),
      gitWorkbenchButton(context, project.id, task.id),
      projectTrustButton(project.id, task.id),
      workflowButton(context, project.id, task.id),
      gitToggle
    ));
  if (task.issue) {
    const chip = task.issueUrl ? link(`#${task.issue}`, task.issueUrl, 'state-chip') : el('span', 'state-chip', `#${task.issue}`);
    chip.setAttribute('aria-label', `${t('github.issue')} #${task.issue}`);
    if (chip instanceof HTMLAnchorElement) { chip.target = '_blank'; chip.rel = 'noopener noreferrer'; }
    header.append(chip);
  }
  const transcript = el('div', 'transcript');
  transcript.setAttribute('role', 'region');
  transcript.setAttribute('aria-label', task.title);
  transcript.setAttribute('aria-live', 'off');
  const announcer = statusRegion();
  node.append(announcer);
  const approvalHost = el('div', 'tool-approvals');
  node.append(approvalHost);
  const transcriptRows = el('div', 'transcript-rows');
  const virtualHost = el('div', 'transcript-window');
  transcriptRows.append(virtualHost);
  const virtual = new TranscriptWindow(transcript, virtualHost, () => following);
  const earlier = button(t('chat.earlier'), () => loadEarlier(), 'load-earlier');
  earlier.hidden = true;
  async function loadEarlier(): Promise<void> {
    if (loadingHistory) return loadingHistory;
    if (history.start === 0) return;
    const before = history.start;
    const revision = history.revision;
    earlier.disabled = true;
    loadingHistory = (async () => {
      try {
        const page = await request<ChatHistory>(
          query('/api/chat/history', { project: project.id, task: task.id, before: String(before) }),
        );
        if (!alive || !history.prepend(page, before, revision)) return;
        virtual.prepend(windowRows(page.rows, page.start));
        earlier.hidden = history.start === 0;
      } finally {
        loadingHistory = null;
        earlier.disabled = false;
      }
    })();
    return loadingHistory;
  }
  const latest = button(
    t('chat.latest'),
    () => {
      following = true;
      transcript.scrollTop = transcript.scrollHeight;
      virtual.refresh();
      latest.hidden = true;
    },
    'latest');
  latest.hidden = true;
  transcript.onscroll = () => {
    following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    latest.hidden = following;
  };
  const question = el('div', 'question-area');
  const queueNode = el('div', 'queue-strip');
  const composer = el('div', 'composer');
  transcript.append(earlier, transcriptRows, question);
  const draftKey = `yumeewade.draft.${project.id}/${task.id}`;
  const pickKey = `yumeewade.pick.${project.id}/${task.id}`;
  const draft = area(
    readLocal<string>(draftKey, ''),
    t(readLocal('yumeewade.enterToSend', false) ? 'chat.placeholderEnter' : 'chat.placeholder'));
  draft.maxLength = context.state.limits.promptChars;
  draft.rows = 2;
  function resizeDraft(): void {
    draft.style.height = 'auto';
    draft.style.height = `${Math.min(208, Math.max(48, draft.scrollHeight))}px`;
  }
  draft.oninput = () => {
    storeLocal(draftKey, draft.value);
    resizeDraft();
  };
  header.append(githubLinkedFeedbackPanel(context, project.id, task.id, value => {
    draft.value = value; storeLocal(draftKey, value); resizeDraft(); draft.focus();
  }));
  const disposeComposeInsert = attachComposeInsert(draft, project.id, task.id);
  const initialPick = readLocal(
    pickKey,
    { ai: task.cli || context.state.settings.initial.ai, model: task.model || context.state.settings.initial.model, effort: task.effort || context.state.settings.initial.effort });
  let reviewControl: HTMLElement | undefined;
  const pick = aiPicker(context.state, initialPick, value => {
    storeLocal(pickKey, value);
    slashCommands.refresh();
    reviewControl?.dispatchEvent(new Event('review-pick-change'));
  }, false, true);
  const upload = attachments(project.id, context.state.limits, draft, task.id);
  const actions = el('div', 'send-actions');
  const running = el('p', 'running-line');
  // One send at a time: the draft is cleared only after the request returns, so a repeated shortcut (key repeat, double
  // press) would otherwise post the same text again — while running, as a second queued copy.
  let sending = false;
  async function send(mode?: SendMode, text = draft.value.trim(), answer = false, retry?: Extract<ChatRow, { role: 'user' }>): Promise<boolean> {
    if (sending || (retry && busy)) return false;
    sending = true;
    try {
      if (!retry) await upload.ready();
      const images = retry ? (retry.images ?? []).map(path => path.split(/[\\/]/).pop()!) : answer ? [] : upload.ids();
      const selection = retry ? { ai: retry.to, ...(retry.model ? { model: retry.model } : {}), ...(retry.effort ? { effort: retry.effort } : {}) } : pick.value();
      if (!text && !images.length) {
        toast(t('chat.needText'));
        return false;
      }
      if ((!busy || (mode !== undefined && mode !== 'queue')) && !await confirmUsageRound({ project: project.id, task: task.id, ai: selection.ai, account: context.state.settings.activeAccounts[selection.ai] ?? 'default' })) return false;
      await api.send({ project: project.id, task: task.id, text, ...selection, ...(busy ? { mode: mode ?? 'queue' } : {}), answer, images });
      if (!retry) storeLocal(pickKey, pick.value());
      if (!answer && !retry) {
        draft.value = '';
        resizeDraft();
        storeLocal(draftKey, '');
        await upload.clear();
      }
    } finally { sending = false; }
    await context.refresh();
    return true;
  }
  draft.onkeydown = event => {
    if (shouldSend(event, readLocal('yumeewade.enterToSend', false))) {
      event.preventDefault();
      void run(() => send(busy ? 'queue' : undefined));
    }
  };
  function controls(): void {
    renderPermissions(approvalHost, busy, project.id, task.id);
    if (busy) {
      actions.replaceChildren(
        button(t('chat.stop'), () => request('/api/chat/stop', { project: project.id, task: task.id }), 'danger'),
        button(t('chat.redo'), () => send('redo'), 'danger'),
        button(t('chat.amend'), () => send('amend')),
        button(t('chat.queue'), () => send('queue'), 'primary'),
      );
    } else {
      actions.replaceChildren();
    }
    clock();
    renderQueue();
    updateHeaderActions();
  }
  function clock(): void {
    if (!busy) {
      running.textContent = '';
      running.hidden = true;
      return;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(busy.startedAt)) / 1000));
    const time = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
    running.hidden = false;
    running.textContent = t('chat.running', { ai: aiLabel(busy.ai), model: modelLabel(context.state, busy.ai, busy.model), time });
    if (busy.approvals?.length) running.textContent += ` · ${t('permission.waiting')}`;
    const timer = transcript.querySelector<HTMLElement>('.live-time');
    if (timer) timer.textContent = time;
  }
  function renderQueue(): void {
    queueNode.replaceChildren(...queue.map((item, index) => {
      const q = el('div', 'queue-item');
      q.append(
        el('strong', '', t('chat.next', { n: index + 1 })),
        el('span', 'queue-text', item.text),
        el(
          'span',
          'muted',
          `${aiLabel(item.ai)} · ${modelLabel(context.state, item.ai, item.model)} · ${effortLabel(item.effort)}`
        ));
      if (item.error) q.append(el('span', 'error-mark', t('chat.error')));
      // Editing moves the instruction (and its images) back into the composer; the queue item is removed.
      q.append(iconButton('✎', labelValue(t('chat.editQueued'), t('chat.next', { n: index + 1 })), async () => {
        queue = await request<QueueItem[]>('/api/chat/unqueue', { project: project.id, task: task.id, id: item.id, restore: true });
        renderQueue();
        const current = draft.value.trim();
        draft.value = current ? `${current}\n\n${item.text}` : item.text; storeLocal(draftKey, draft.value); resizeDraft(); draft.focus();
        if (item.images?.length) await upload.reload();
      }));
      q.append(iconButton('×', labelValue(t('common.remove'), t('chat.next', { n: index + 1 })), async () => {
        queue = await request<QueueItem[]>('/api/chat/unqueue', { project: project.id, task: task.id, id: item.id });
        renderQueue();
      }));
      if (!busy && index === 0) {
        q.append(button(
          t('chat.startQueued'),
          async () => {
            if (!await confirmUsageRound({ project: project.id, task: task.id, ai: item.ai, account: context.state.settings.activeAccounts[item.ai] ?? 'default' })) return;
            await api.send({ project: project.id, task: task.id, text: '', fromQueue: item.id });
          },
          'primary',
        ));
      }
      return q;
    }));
    if (queue.some(item => item.error)) {
      queueNode.prepend(el('p', 'warning queue-paused', t('chat.queuePaused')));
    }
    queueNode.hidden = !queue.length;
  }
  let live: HTMLElement | null = null;
  let liveBody: HTMLElement | null = null;
  let liveTail: HTMLElement | null = null;
  let liveMarkdown = new MarkdownStream();
  function renderLive(): void {
    if (!liveBody) return;
    for (const block of liveMarkdown.takeCompleted()) {
      const rendered = markdown(block);
      liveBody.insertBefore(rendered, liveTail);
    }
    const next = markdown(liveMarkdown.tail() || (partial ? '' : '…'));
    if (liveTail) liveTail.replaceWith(next);
    else liveBody.append(next);
    liveTail = next;
  }
  let liveFrame = 0;
  let toolGroup: HTMLDetailsElement | null = null;
  let toolCount = 0;
  function follow(): void {
    if (following) transcript.scrollTop = transcript.scrollHeight;
    virtual.refresh();
    latest.hidden = following;
  }
  function removeLive(): void {
    cancelAnimationFrame(liveFrame);
    liveFrame = 0;
    live?.remove();
    live = null;
    liveBody = null;
    liveTail = null;
  }
  function addLive(): void {
    removeLive();
    if (!busy) return;
    live = el('article', 'chat-card assistant live');
    liveBody = el('div', 'markdown-stream');
    liveMarkdown = new MarkdownStream();
    liveMarkdown.push(partial);
    renderLive();
    live.append(
      row(
        el('span', 'dot running'),
        el(
          'strong',
          '',
          `${aiLabel(busy.ai)} · ${modelLabel(context.state, busy.ai, busy.model)} · ${effortLabel(busy.effort)}`
        ),
        el('span', 'live-time')
      ),
      liveBody);
    transcriptRows.append(live);
    clock();
    follow();
  }
  function appendRow(entry: ChatRow, index: number, target = transcriptRows): void {
    const before = null;
    if (entry.role === 'event' && entry.tool) {
      if (!toolGroup) {
        toolCount = 0;
        toolGroup = disclosure('');
        toolGroup.className = 'tool-events';
        target.insertBefore(toolGroup, before);
      }
      toolGroup.querySelector('summary')!.textContent = t('chat.tools', { n: ++toolCount });
      const toolRow = el('pre', 'tool-row', entry.text);
      toolRow.dataset['index'] = String(index);
      toolGroup.append(toolRow);
      return;
    }
    toolGroup = null;
    if (entry.role === 'event') {
      const eventRow = el('div', 'event-row', entry.text);
      eventRow.dataset['index'] = String(index);
      target.insertBefore(eventRow, before);
      return;
    }
    const item = el('article', `chat-card ${entry.role}`);
    item.dataset['index'] = String(index);
    const metadata = el('div', 'chat-meta');
    if (entry.role === 'user') {
      metadata.append(
        el('strong', '', t('chat.you')),
        el('time', '', localTime(entry.at)),
        el(
          'span',
          '',
          `→ ${aiLabel(entry.to)} · ${modelLabel(context.state, entry.to, entry.model)} · ${effortLabel(entry.effort)}`
        ));
      if (entry.mode) metadata.append(el('span', 'mode-tag', t(`chat.mode.${entry.mode}`)));
      for (const mention of entry.mentions ?? []) metadata.append(el('span', 'mode-tag', `@${mention.token} · ${t(`mention.${mention.status}`)}`));
      if (entry.checkpoint) {
        const undo = button(t('chat.rollback'), () => run(async () => {
          if (busy || !await confirmModal(t('chat.rollback'), t('chat.rollbackConfirm'), t('chat.rollback'))) return;
          await request('/api/chat/rollback', { project: project.id, task: task.id, request: entry.request });
          toast(t('chat.rollbackDone'));
        }), 'retry-message');
        undo.hidden = !!busy;
        metadata.append(undo);
        const branch = button(t('chat.fork'), () => run(async () => {
          if (busy) return;
          const created = await request<Task>('/api/chat/fork', { project: project.id, task: task.id, request: entry.request });
          await context.refresh();
          toast(t('chat.forked'));
          location.hash = taskHash(project.id, created.id);
        }), 'retry-message');
        branch.hidden = !!busy;
        metadata.append(branch);
      }
      item.append(metadata, el('p', 'user-text', entry.text));
      if (entry.images?.length) {
        const images = el('div', 'image-strip');
        for (const path of entry.images) {
          const name = path.split(/[\\/]/).pop() ?? '';
          const img = el('img', 'transcript-image');
          img.src = query('/api/attachment', { project: project.id, task: task.id, name });
          img.alt = name;
          const preview = button(
            '',
            () => {
              const full = el('img', 'full-image');
              full.src = img.src;
              full.alt = name;
              modal(name, full);
            },
            'image-preview');
          preview.setAttribute('aria-label', name);
          preview.append(img);
          images.append(preview);
        }
        item.append(images);
      }
    } else {
      metadata.append(
        el('strong', '', aiLabel(entry.ai)),
        el('span', '', `${modelLabel(context.state, entry.ai, entry.model)} · ${effortLabel(entry.effort)}`),
        el('time', '', localTime(entry.at)),
        el('span', '', t('chat.duration', { seconds: Math.round(entry.ms / 1000) })));
      if (entry.changes) {
        const { files, added, removed } = entry.changes;
        metadata.append(button(t('chat.changes', { files, added, removed }), () => run(() => openDiff('', () => request(query('/api/chat/turn-diff', { project: project.id, task: task.id, request: entry.request })))), 'turn-changes'));
      }
      if (entry.usage) {
        const format = new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 });
        const usage = el('span', 'turn-usage', t('chat.turnUsage', { input: format.format(entry.usage.input), output: format.format(entry.usage.output) })
          + (entry.usage.cached === undefined ? '' : t('chat.cachedUsage', { cached: format.format(entry.usage.cached) })));
        usage.title = t('chat.usageHint');
        metadata.append(usage);
      }
      if (entry.error || entry.stopped) {
        const retry = button(t('chat.retry'), async () => {
          while (alive && !busy) {
            let at = rows.indexOf(entry);
            while (at > 0) {
              const previous = rows[--at]!;
              if (previous.role === 'user') {
                await send(undefined, previous.text, false, previous);
                return;
              }
            }
            if (history.start === 0) return;
            const before = history.start;
            await loadEarlier();
            if (history.start === before) return;
          }
        }, 'retry-message');
        retry.hidden = !!busy;
        metadata.append(retry);
      }
      if (entry.stopped) metadata.append(el('span', 'stopped-mark', t('chat.stopped')));
      if (entry.error) {
        metadata.append(el('span', 'error-mark', t(entry.error === 'interrupted' ? 'chat.interrupted' : entry.error === 'timeout' ? 'chat.timedOut' : 'chat.error')));
      }
      item.append(metadata, markdown(entry.text));
    }
    if (entry.request) metadata.append(contextManifestButton(project.id, task.id, entry.request));
    metadata.append(button(t('chat.copy'), async () => {
      try { await copyText(entry.text); toast(t('markdown.copied')); }
      catch { toast(t('markdown.copyFailed')); }
    }, 'copy-message'));
    target.insertBefore(item, before);
  }
  let lastToolUnit: { key: number; entries: ChatRow[] } | null = null;
  const toolKeys = new Map<number, number>();
  function unitKey(index: number): number { return toolKeys.get(index) ?? index; }
  function windowRow(entries: ChatRow[], key: number): WindowRow {
    return { key, render: () => {
      const container = el('div', 'transcript-window-row');
      container.style.display = 'flow-root';
      toolGroup = null;
      for (const [offset, entry] of entries.entries()) appendRow(entry, key + offset, container);
      toolGroup = null;
      return container;
    } };
  }
  function windowRows(entries: ChatRow[], start: number): WindowRow[] {
    const result: WindowRow[] = [];
    let group: { key: number; entries: ChatRow[] } | null = null;
    for (const [offset, entry] of entries.entries()) {
      const index = start + offset;
      if (entry.role === 'event' && entry.tool) {
        // Bound expanded tool groups as well as regular cards.
        if (!group || group.entries.length >= 24) {
          group = { key: index, entries: [] };
          result.push(windowRow(group.entries, group.key));
        }
        group.entries.push(entry);
        toolKeys.set(index, group.key);
      } else {
        group = null;
        result.push(windowRow([entry], index));
      }
    }
    if (start + entries.length === history.start + rows.length) lastToolUnit = group;
    return result;
  }
  function appendWindowRow(entry: ChatRow, index: number): void {
    if (entry.role === 'event' && entry.tool && lastToolUnit && lastToolUnit.entries.length < 24) {
      lastToolUnit.entries.push(entry);
      toolKeys.set(index, lastToolUnit.key);
      virtual.replace(windowRow(lastToolUnit.entries, lastToolUnit.key));
    } else {
      const units = windowRows([entry], index);
      virtual.append(units[0]!);
    }
  }
  function renderTranscript(): void {
    const top = transcript.scrollTop;
    removeLive();
    toolKeys.clear();
    virtual.reset(windowRows(rows, history.start));
    addLive();
    renderQuestion();
    if (!following) transcript.scrollTop = top;
    follow();
  }
  function renderQuestion(): void {
    // 重畫串流文字不應吃掉使用者正在輸入的答案；問題內容沒變就保留 DOM。
    const lastAssistant = [...rows].reverse().find((entry): entry is Extract<ChatRow, { role: 'assistant' }> => entry.role === 'assistant' && !!entry.asks?.length);
    const asks = lastAssistant?.asks ?? [];
    const key = task.question ? JSON.stringify([task.question, asks]) : '';
    if (question.dataset['key'] === key) return;
    question.dataset['key'] = key;
    question.replaceChildren();
    if (!task.question) return;
    const panel = el('div', 'question-card');
    announcer.textContent = t('chat.question');
    panel.append(el('h3', '', t('chat.question')));
    const answerParts: string[][] = asks.map(() => []);
    if (asks.length) {
      for (const [i, ask] of asks.entries()) {
        const group = el('div', 'question-group');
        group.append(el('p', '', ask.question));
        if (ask.multi) {
          for (const option of ask.options) {
            const check = input();
            check.type = 'checkbox';
            check.onchange = () => {
              answerParts[i] = Array.from(group.querySelectorAll<HTMLInputElement>('input:checked'))
                .map(c => c.value);
            };
            check.value = option;
            group.append(field(option, check));
          }
        } else {
          for (const option of ask.options) {
            group.append(button(option, () => send(busy ? 'queue' : undefined, option, true), 'option-button'));
          }
        }
        panel.append(group);
      }
    } else {
      panel.append(el('p', '', task.question));
    }
    const free = area('', t('chat.freeAnswer'));
    panel.append(
      free,
      row(
        button(
          t('chat.send'),
          async () => {
            const answers = answerParts.flat();
            if (free.value.trim()) answers.push(free.value.trim());
            await send(busy ? 'queue' : undefined, answers.join('\n'), true);
          }
        ),
        button(
          t('chat.clearQuestion'),
          async () => {
            await request('/api/task/update', { project: project.id, task: task.id, patch: { question: '' } });
            await context.refresh();
          },
          'subtle'
        )
      ));
    question.append(panel);
    if (following) transcript.scrollTop = transcript.scrollHeight;
  }
  let previewSerial = 0;
  let mergeLeftover: string[] = [];
  async function openDiff(focusPath = '', load?: () => Promise<{ diff: string; truncated: boolean }>): Promise<void> {
    const diff = await (load ? load() : api.diff(project.id, task.id));
    const viewer = el('div', 'diff-viewer');
    const savedReviews = await reviewDrafts(project.id, task.id, diff.diff);
    if (!alive) return;
    if (savedReviews.stale.length) viewer.append(el('p', 'warning', t('context.stale', { n: savedReviews.stale.length })));
    if (diff.truncated) viewer.append(el('p', 'warning diff-warning', t('copy.truncated')));
    const files = parseDiff(diff.diff);
    if (!files.length) viewer.append(el('p', 'muted', t('copy.noChanges')));
    const comments = new Map<DiffLine, ReviewItem>();
    const reviewSend = button('', () => run(async () => {
      await savedReviews.ready();
      if (!await send(busy ? 'queue' : undefined, buildReviewPrompt(t('review.prompt'), [...comments.values()]))) return;
      await savedReviews.clear();
      reviewSend.closest('dialog')?.close();
    }), 'primary');
    const reviewBar = el('div', 'review-bar');
    reviewBar.hidden = true;
    reviewBar.append(reviewSend);
    function attachReview(row: HTMLElement, path: string, line: DiffLine): void {
      const where = line.newLine === undefined ? t('review.removedAt', { path, line: line.oldLine ?? 0 }) : `${path}:${line.newLine}`;
      const saved = savedReviews.get(path, line);
      if (saved) comments.set(line, { where, code: saved.code, comment: saved.comment });
      let box: HTMLTextAreaElement | undefined;
      const open = () => {
        if (!box) {
          const input = el('textarea', 'review-input');
          input.placeholder = t('review.placeholder');
          input.rows = 2;
          input.value = saved?.comment ?? '';
          input.addEventListener('input', () => {
            if (input.value.trim()) comments.set(line, { where, code: line.text.slice(1).trim(), comment: input.value });
            else comments.delete(line);
            void run(() => savedReviews.set(path, line, input.value));
            row.classList.toggle('reviewed', comments.has(line));
            reviewBar.hidden = comments.size === 0;
            reviewSend.textContent = t('review.send', { n: comments.size });
          });
          row.after(input);
          box = input;
        }
        box.focus();
      };
      row.classList.add('reviewable');
      row.tabIndex = 0;
      row.title = t('review.add');
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
      if (saved) open();
      row.classList.toggle('reviewed', comments.has(line));
      reviewBar.hidden = comments.size === 0;
      reviewSend.textContent = t('review.send', { n: comments.size });
    }
    let focused: HTMLElement | null = null;
    for (const [index, file] of files.entries()) {
      const section = disclosure('');
      section.className = 'diff-file';
      section.open = index < 3 || file.path === focusPath;
      section.querySelector('summary')!.append(el('span', 'diff-path', file.path || t('copy.diff')),
        el('span', 'diff-added', `+${file.added}`), el('span', 'diff-removed', `−${file.removed}`));
      const content = el('pre', 'diff-lines');
      for (const line of file.lines) {
        const row = el('span', `diff-line diff-${line.kind}`, line.text);
        content.append(row);
        if (line.oldLine !== undefined || line.newLine !== undefined) attachReview(row, file.path, line);
      }
      section.append(load ? content : sideDiff(content, { project: project.id, task: task.id, path: file.path, mode: 'copy' }));
      viewer.append(section);
      if (focusPath && file.path === focusPath) focused = section;
    }
    viewer.append(reviewBar);
    modal(t('copy.diff'), viewer);
    focused?.scrollIntoView({ block: 'start' });
  }
  const gitFileLimit = 200;
  function gitRow(label: string, value: string): HTMLElement {
    const item = el('div', 'git-row');
    item.append(el('span', 'muted', label), el('code', '', value));
    return item;
  }
  async function renderWork(): Promise<void> {
    const serial = ++previewSerial;
    work.replaceChildren();
    setGitBadge();
    if (mergeLeftover.length) {
      const notice = el('div', 'warning merge-leftover');
      notice.setAttribute('role', 'status');
      notice.append(el('p', '', t('copy.leftover')), el('pre', '', mergeLeftover.join('\n')));
      work.append(notice);
    }
    if (task.copyMissing) {
      work.append(
        el('p', 'warning', t('copy.missing')),
        button(
          t('copy.clear'),
          async () => {
            await request('/api/task/copyclear', { project: project.id, task: task.id });
            await context.refresh();
          }
        ));
      return;
    }
    if (!task.copy) {
      const note = el('p', 'muted', t(task.workspace === 'direct' ? 'git.direct' : 'git.noCopy'));
      work.append(note);
      if (task.workspace !== 'direct' && task.state === '完成') {
        const merged = await request<{ commit: string } | null>(query('/api/task/merged', { project: project.id, task: task.id }));
        if (serial === previewSerial && merged) {
          note.remove();
          work.append(el('p', '', t('git.merged', { commit: merged.commit })), button(t('git.unmerge'), async () => {
            if (!await confirmModal(t('git.unmerge'), t('git.unmergeConfirm'), t('git.unmerge'))) return;
            await request('/api/task/unmerge', { project: project.id, task: task.id });
            await context.refresh();
            toast(t('git.unmerged'));
          }, 'danger'));
        }
      }
      return;
    }
    const info = el('div', 'git-info');
    const actions = el('div', 'git-actions');
    work.append(info, actions);
    let mergeButton: HTMLButtonElement | null = null;
    if (task.mergeExcluded) {
      info.append(el('p', 'muted', t('copy.excluded')));
    } else {
      mergeButton = button(
        t('copy.merge'),
        async () => {
          if (!await confirmModal(t('copy.merge'), t('copy.confirmMerge'), t('copy.merge'))) return;
          const result = await api.merge(project.id, task.id);
          mergeLeftover = result.leftover ?? [];
          if (result.conflicts?.length) {
            modal(t('copy.conflict'), el('pre', '', result.conflicts.join('\n')));
          } else {
            toast(t('copy.merged'));
          }
          await context.refresh();
          await renderWork();
        },
        'primary');
      mergeButton.disabled = true;
      actions.append(mergeButton);
    }
    actions.append(
      button(
        t(task.mergeExcluded ? 'copy.restore' : 'copy.exclude'),
        async () => {
          await request('/api/task/merge-exclusion', { project: project.id, task: task.id, excluded: !task.mergeExcluded });
          await context.refresh();
        }
      ),
      button(t('copy.diff'), () => openDiff()));
    const preview = await api.preview(project.id, task.id);
    if (!alive || serial !== previewSerial || !preview) return;
    const verified = hasVerification() || project.requireVerification
      ? await request<VerifyStatus | null>(query('/api/task/verify', { project: project.id, task: task.id })) : undefined;
    if (!alive || serial !== previewSerial) return;
    const currentPass = !!verified?.ok && !verified.drifted;
    if (mergeButton) {
      mergeButton.disabled = preview.files === 0 || !!project.requireVerification && !currentPass;
      mergeButton.title = project.requireVerification && !currentPass ? t('detail.verification_required') : '';
    }
    if (project.requireVerification && !currentPass) info.append(el('p', 'warning', t('detail.verification_required')));
    const reviewer = context.state.ais.find(a => a.name !== 'mock' && a.available && a.name !== task.cli);
    if (reviewer && preview.files > 0) {
      const review = await reviewButton(project.id, task.id,
        () => ({ ai: reviewer.name, text: t('git.reviewPrompt', { target: preview.target }) }),
        () => { if (alive) void run(() => context.refresh()); }, ai => context.state.settings.activeAccounts[ai] ?? 'default');
      if (!alive || serial !== previewSerial) return;
      actions.append(review);
    }
    setGitBadge(preview.files, preview.conflict);
    info.append(
      gitRow(t('git.branch'), preview.branch),
      gitRow(t('git.target'), preview.target),
      el('p', 'copy-stats', preview.files === 0
        ? t('copy.noChanges')
        : t('copy.stats', { files: preview.files, added: preview.added, removed: preview.removed })));
    if (verified !== undefined) {
      info.append(verified
        ? el('p', verified.ok && !verified.drifted ? 'verify-pass' : 'error-mark', t(verified.ok && !verified.drifted ? 'git.verifyPass' : 'git.verifyFail', { time: localTime(verified.at) }))
        : el('p', 'muted', t('git.verifyNone')));
      if (verified?.drifted) info.append(el('p', 'warning', t('verification.hint')));
      if (verified) info.append(...verificationSteps(verified));
    }
    if (preview.paths.length) {
      const list = el('ul', 'git-files');
      for (const file of preview.paths.slice(0, gitFileLimit)) {
        const item = el('li');
        const open = button(file, () => openDiff(file), 'subtle git-file');
        open.title = file;
        item.append(open);
        const revert = iconButton('↩', labelValue(t('git.revertFile'), file), async () => {
          if (busy || !await confirmModal(t('git.revertFile'), t('git.revertConfirm', { file }), t('git.revertFile'))) return;
          await request('/api/task/revert-file', { project: project.id, task: task.id, path: file });
          await context.refresh();
          await renderWork();
          toast(t('git.reverted'));
        }, 'subtle git-revert');
        item.append(revert);
        list.append(item);
      }
      info.append(el('h3', '', t('git.files', { n: preview.paths.length })), list);
      if (preview.paths.length > gitFileLimit) {
        info.append(el('p', 'muted', t('git.moreFiles', { n: preview.paths.length - gitFileLimit })));
      }
    }
    if (preview.conflict) {
      info.append(disclosure(t('copy.conflict'), el('pre', 'warning', preview.conflictPaths.join('\n'))));
    }
    if (preview.overlaps.length) {
      const lines = preview.overlaps.map(o => `${o.title}（${o.task}）\n${o.paths.map(p => `  ${p}`).join('\n')}`).join('\n');
      info.append(disclosure(t('git.overlap', { n: preview.overlaps.length }), el('pre', 'warning', lines)));
    }
    if (preview.mainDirty) info.append(el('p', 'muted', t('copy.mainDirty')));
  }
  const footer = el('div', 'task-footer');
  // Text inputs live across footer redraws: the AI checking a step or another tab saving must not wipe what the user is typing.
  const addStep = input('', t('task.addStep')); addStep.maxLength = 2000;
  const addStepButton = button(t('common.add'), async () => {
    if (!addStep.value.trim()) return;
    await request('/api/task/step', { project: project.id, task: task.id, add: addStep.value.trim() });
    addStep.value = '';
    await context.refresh();
  });
  const memo = input('', t('task.memo'));
  memo.maxLength = 300;
  memo.setAttribute('aria-label', t('task.memo'));
  const leaveMemo = button(t('task.leaveMemo'), async () => {
    if (!memo.value.trim()) return;
    await request('/api/task/memo', { project: project.id, task: task.id, text: memo.value.trim() });
    memo.value = '';
    await context.refresh();
  });
  let metadata: { key: string; node: HTMLElement } | undefined;
  function renderFooter(): void {
    const state = select(TASK_STATES.map(value => ({ value, label: t(`state.${value}`) })), task.state);
    state.onchange = () => {
      void run(async () => {
        await request('/api/task/update', { project: project.id, task: task.id, patch: { state: state.value } });
        await context.refresh();
      });
    };
    const phase = select(
      // A phase removed from the project stays on its tasks; keep it selectable instead of showing "none".
      [{ value: '', label: t('common.none') }, ...project.phases.map(p => ({ value: p.name, label: p.name })), ...(task.phase && !project.phases.some(p => p.name === task.phase) ? [{ value: task.phase, label: task.phase }] : [])],
      task.phase);
    phase.onchange = () => {
      void run(async () => {
        await request('/api/task/update', { project: project.id, task: task.id, patch: { phase: phase.value } });
        await context.refresh();
      });
    };
    const steps = el('div', 'step-list');
    task.steps.forEach((step, index) => {
      const check = input();
      check.type = 'checkbox';
      check.checked = step.done;
      check.onchange = () => {
        void run(async () => {
          // The step text lets the core refuse if the list changed underneath this page; refresh either way to resync the checkbox.
          try { await request('/api/task/step', { project: project.id, task: task.id, index, text: step.text, done: check.checked }); }
          finally { await context.refresh(); }
        });
      };
      // Every step change names the text shown; a stale list gets a 409 and the refresh resyncs it.
      const change = (body: Record<string, unknown>) => async () => {
        try { await request('/api/task/step', { project: project.id, task: task.id, text: step.text, ...body }); }
        finally { await context.refresh(); }
      };
      // A step moved to either end has that direction disabled; keep keyboard focus on the step via the other arrow.
      const move = (offset: -1 | 1) => async () => {
        await change({ index, move: offset })();
        const [same, other] = [t(offset < 0 ? 'tasks.stepUp' : 'tasks.stepDown'), t(offset < 0 ? 'tasks.stepDown' : 'tasks.stepUp')].map(name => footer.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(labelValue(name, step.text))}"]`));
        if (same?.disabled) other?.focus();
      };
      const up = iconButton('↑', labelValue(t('tasks.stepUp'), step.text), move(-1));
      const down = iconButton('↓', labelValue(t('tasks.stepDown'), step.text), move(1));
      up.disabled = index === 0; down.disabled = index === task.steps.length - 1;
      steps.append(row(
        field(step.text, check),
        iconButton('✎', labelValue(t('tasks.editStep'), step.text), async () => {
          const text = await textModal(t('tasks.editStep'), step.text, 2000, 3);
          if (text === null || !text.trim() || text.trim() === step.text) return;
          await change({ index, rename: text })();
        }),
        up, down,
        iconButton('×', labelValue(t('common.remove'), step.text), change({ remove: index })),
      ));
    });
    steps.append(row(addStep, addStepButton));
    const detail = disclosure(t('task.steps', { done: task.steps.filter(s => s.done).length, total: task.steps.length }), steps);
    detail.open = footer.querySelector<HTMLDetailsElement>('details.steps-detail')?.open ?? false;
    detail.classList.add('steps-detail');
    // The free-text sections the AI maintains are loaded only when opened; they can be long and are not part of /api/state.
    const recordBody = el('div', 'task-record');
    const record = disclosure(t('tasks.record'), recordBody);
    record.classList.add('record-detail');
    record.ontoggle = () => {
      if (!record.open) return;
      void run(async () => {
        const sections = await request<TaskSections>(query('/api/task/sections', { project: project.id, task: task.id }));
        const parts = ([['tasks.doneSection', sections.done], ['tasks.next', sections.next], ['tasks.cautions', sections.cautions], ['tasks.memos', sections.memo]] as const)
          .filter(([, lines]) => lines.length)
          .map(([key, lines]) => { const part = el('section', ''); part.append(el('h4', '', t(key)), markdown(lines.join('\n'))); return part; });
        recordBody.replaceChildren(...(parts.length ? parts : [el('p', 'empty', t('common.empty'))]));
      });
    };
    // A search hit in the record links here with ?record=1; afterwards the reader's own toggle is kept.
    record.open = footer.querySelector<HTMLDetailsElement>('details.record-detail')?.open ?? params.has('record');
    state.setAttribute('aria-label', t('task.state'));
    state.title = t('task.state');
    phase.setAttribute('aria-label', t('task.phase'));
    phase.title = t('task.phase');
    // Due date and tags are only rebuilt when they changed, so an unsaved edit survives unrelated redraws.
    const metadataKey = JSON.stringify([task.due, task.tags]);
    if (metadata?.key !== metadataKey) metadata = { key: metadataKey, node: metadataEditor(project.id, task, () => context.refresh()) };
    const focused = footer.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    // The ledger keeps the AI's "next" section and the memo log; show the first next step and the newest memo instead of hiding them in a tooltip.
    const notes = [task.next && labelValue(t('tasks.next'), task.next), task.memo && labelValue(t('tasks.latestMemo'), task.memo)].filter(Boolean) as string[];
    footer.replaceChildren(...notes.map(text => { const line = el('p', 'muted task-notes', text); line.title = text; return line; }), row(state, phase, detail, memo, leaveMemo), record, metadata.node);
    // Rebuilt step buttons are found again by label, so ↑/↓ keeps keyboard focus on the moved step.
    const label = focused?.getAttribute('aria-label');
    (focused?.isConnected ? focused : label ? footer.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`) : null)?.focus();
  }
  const composerControls = row(pick.node, upload.node, snippetsButton(draft), contextButton(project.id, task.id, () => pick.value()));
  void run(async () => {
    const control = await reviewButton(project.id, task.id,
      () => ({ ...pick.value(), text: draft.value.trim() || t('readonlyReview.prompt') }),
      () => { if (alive) void run(() => context.refresh()); }, ai => context.state.settings.activeAccounts[ai] ?? 'default');
    if (!alive) return;
    reviewControl = control;
    composerControls.append(control);
    control.dispatchEvent(new Event('review-pick-change'));
  });
  composerControls.classList.add('composer-controls');
  const mentions = attachMention(draft, async q => (await request<{ files: string[] }>(query('/api/task/files', { project: project.id, task: task.id, q }))).files);
  const slashCommands = attachSlashCommands(draft, () => {
    const ai = pick.value().ai;
    return JSON.stringify([ai, context.state.settings.activeAccounts[ai], context.state.settings.accounts[ai], task.workdir, task.copy, task.copyMissing]);
  }, async () => {
    const ai = pick.value().ai;
    if (ai !== 'claude' && ai !== 'codex' && ai !== 'grok' && ai !== 'gemini') return [];
    return (await request<{ commands: SlashCommand[] }>(query('/api/chat/commands', { project: project.id, task: task.id, ai }))).commands;
  });
  composer.append(queueNode, mentions, slashCommands.node, draft, upload.strip, running, composerControls, actions);
  const column = el('div', 'task-column');
  column.append(header, transcript, latest, composer, footer);
  node.append(column, gitPanel);
  controls();
  renderFooter();
  void run(renderWork);
  const resizeFrame = requestAnimationFrame(resizeDraft);
  function receive(event: ChatEvent): void {
    switch (event.event) {
      case 'snapshot':
        history.reset({ rows: event.data.rows, start: event.data.start });
        rows = history.rows;
        earlier.hidden = history.start === 0;
        busy = event.data.busy;
        partial = event.data.partial;
        queue = event.data.queue;
        renderTranscript();
        controls();
        void run(focusHistory);
        break;
      case 'busy':
        busy = event.data;
        announcer.textContent = '';
        partial = '';
        addLive();
        controls();
        break;
      case 'approvals':
        if (busy) busy.approvals = event.data;
        announcer.textContent = event.data.length ? t('permission.waiting') : '';
        controls();
        break;
      case 'delta':
        if (busy?.request === event.data.request) {
          partial += event.data.text;
          liveMarkdown.push(event.data.text);
          if (!liveFrame) {
            liveFrame = requestAnimationFrame(() => {
              liveFrame = 0;
              renderLive();
              follow();
            });
          }
        }
        break;
      case 'row':
        rows.push(event.data);
        if (event.data.role === 'assistant' && event.data.request === busy?.request) {
          partial = '';
          removeLive();
        }
        appendWindowRow(event.data, history.start + rows.length - 1);
        renderQuestion();
        follow();
        break;
      case 'queue':
        queue = event.data;
        renderQueue();
        break;
      case 'idle':
        markSeen();
        if (busy?.request === event.data.request) {
          busy = null;
          partial = '';
          removeLive();
          announcer.textContent = task.question ? t('chat.question') : t('notification.done');
        }
        controls();
        follow();
        void context.refresh();
        void run(renderWork);
        break;
    }
  }
  const listeners: Record<string, (message: MessageEvent<string>) => void> = {};
  for (const event of ['snapshot', 'busy', 'approvals', 'delta', 'row', 'queue', 'idle'] as const) {
    listeners[event] = message => {
      try {
        receive({ event, data: JSON.parse(message.data) } as ChatEvent);
      } catch {
        /* 無效 SSE 不改畫面；重連 snapshot 可恢復。 */
      }
    };
  }
  // A finished reply stays unread (and is notified) until it can actually be seen: a page left open in a background or
  // minimized window is not attention, so reads are reported only while this window is visible and focused.
  const markSeen = () => { if (alive && !document.hidden && document.hasFocus()) void request('/api/task/read', { project: project.id, task: task.id }).catch(() => undefined); };
  const onAttention = () => { if (context.state.unread.some(item => item.project === project.id && item.task === task.id)) markSeen(); };
  window.addEventListener('focus', onAttention); document.addEventListener('visibilitychange', onAttention);
  const source = stream(query('/api/chat/stream', { project: project.id, task: task.id }), listeners);
  const timer = window.setInterval(clock, 1000);
  void run(() => request('/api/task/read', { project: project.id, task: task.id }));
  return {
    node,
    dispose: () => {
      alive = false;
      window.removeEventListener('focus', onAttention); document.removeEventListener('visibilitychange', onAttention);
      source.close();
      removeLive();
      virtual.dispose();
      window.clearInterval(timer);
      cancelAnimationFrame(resizeFrame);
      upload.dispose();
      slashCommands.dispose();
      disposeComposeInsert();
    },
    update: (state: AppState) => {
      context.state = state;
      const nextProject = state.projects.find(p => p.id === project.id);
      const nextTask = nextProject?.tasks.find(t => t.id === task.id);
      if (!nextProject || !nextTask) {
        location.hash = projectHash(project.id);
        return;
      }
      const workChanged = JSON.stringify([
        task.copy, task.copyMissing, task.mergeExcluded, task.workdir, task.updated,
        project.verify, project.checks, project.requireVerification,
      ]) !== JSON.stringify([
        nextTask.copy, nextTask.copyMissing, nextTask.mergeExcluded, nextTask.workdir, nextTask.updated,
        nextProject.verify, nextProject.checks, nextProject.requireVerification,
      ]);
      const footerChanged = JSON.stringify([
        task.state, task.phase, task.steps, task.memo, task.next, task.due, task.tags,
      ]) !== JSON.stringify([
        nextTask.state, nextTask.phase, nextTask.steps, nextTask.memo, nextTask.next, nextTask.due, nextTask.tags,
      ]);
      project = nextProject;
      task = nextTask;
      slashCommands.refresh();
      stateChip.textContent = t(`state.${task.state}`);
      reviewControl?.dispatchEvent(new Event('review-pick-change'));
      if (document.activeElement !== title) title.value = task.title;
      renderQuestion();
      updateHeaderActions();
      if (footerChanged) renderFooter();
      if (workChanged) void run(renderWork);
    },
  };
}
