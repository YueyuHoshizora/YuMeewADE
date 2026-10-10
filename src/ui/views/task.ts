import type {
  AppState, Busy, ChatEvent, ChatHistory, ChatRow, ProjectView,
  QueueItem, SendMode, TaskView, VerifyResult,
} from '../../shared/types.ts';
import { TASK_STATES } from '../../shared/types.ts';
import { api, query, request } from '../api.ts';
import { getLocale, t } from '../i18n/index.ts';
import { attachments } from '../components/attachments.ts';
import { aiPicker } from '../components/picker.ts';
import { copyText, markdown } from '../components/markdown.ts';
import { MarkdownStream } from '../components/markdown-stream.ts';
import { HistoryWindow } from '../components/history.ts';
import {
  area, button, confirmModal, disclosure, el, field, iconButton, input, link, modal,
  projectHash, readLocal, row, run, select, statusRegion, storeLocal, toast,
  type View, type ViewContext,
} from '../components/dom.ts';
import { aiLabel, effortLabel, localTime, modelLabel } from '../components/display.ts';
import { shouldSend } from '../components/composer.ts';
import { stream } from '../components/stream.ts';
import { parseDiff } from '../components/diff.ts';

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
        el('strong', result.ok ? 'verify-pass' : 'error-mark', t(result.ok ? 'verify.pass' : 'verify.fail')),
        el('p', '', t('verify.result', { code: result.exitCode ?? t('common.none'), seconds: (result.ms / 1000).toFixed(1) })),
        ...(result.timedOut ? [el('p', 'warning', t('verify.timedOut'))] : []),
        ...(result.truncated ? [el('p', 'warning', t('verify.truncated'))] : []),
        el('pre', 'verify-output', result.output));
    } finally {
      verifying = false;
      updateHeaderActions();
    }
  });
  function updateHeaderActions(): void {
    verifyButton.hidden = !project.verify?.trim() || !!busy;
    verifyButton.disabled = verifying;
    verifyButton.textContent = t(verifying ? 'verify.running' : 'verify.run');
    verifyButton.setAttribute('aria-busy', String(verifying));
    for (const retry of transcriptRows.querySelectorAll<HTMLButtonElement>('.retry-message')) retry.hidden = !!busy;
  }
  const exportLink = link(t('chat.export'), query('/api/chat/export', { project: project.id, task: task.id }), 'export-chat');
  exportLink.download = `${task.title}.md`;
  header.append(
    link(t('common.back', { name: project.name }), projectHash(project.id), 'back-link'),
    row(
      title,
      stateChip,
      button(t('common.open'), () => request('/api/open', { path: task.workdir || project.bodyPath })),
      exportLink,
      verifyButton
    ),
    work);
  const transcript = el('div', 'transcript');
  transcript.setAttribute('role', 'region');
  transcript.setAttribute('aria-label', task.title);
  transcript.setAttribute('aria-live', 'off');
  const announcer = statusRegion();
  node.append(announcer);
  const transcriptRows = el('div', 'transcript-rows');
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
        const top = transcript.scrollTop;
        const height = transcript.scrollHeight;
        const savedGroup = toolGroup;
        const savedCount = toolCount;
        toolGroup = null;
        const prepend = el('div');
        for (const [offset, entry] of page.rows.entries()) {
          appendRow(entry, page.start + offset, prepend);
        }
        transcriptRows.prepend(...Array.from(prepend.childNodes));
        toolGroup = savedGroup;
        toolCount = savedCount;
        earlier.hidden = history.start === 0;
        transcript.scrollTop = top + transcript.scrollHeight - height;
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
  const initialPick = readLocal(
    pickKey,
    { ai: task.cli || context.state.settings.initial.ai, model: task.model || context.state.settings.initial.model, effort: task.effort || context.state.settings.initial.effort });
  const pick = aiPicker(context.state, initialPick, value => storeLocal(pickKey, value), false, true);
  const upload = attachments(project.id, context.state.limits, draft);
  const actions = el('div', 'send-actions');
  const running = el('p', 'running-line');
  async function send(mode?: SendMode, text = draft.value.trim(), answer = false, retry?: Extract<ChatRow, { role: 'user' }>): Promise<void> {
    if (retry && busy) return;
    if (!retry) await upload.ready();
    const images = retry ? (retry.images ?? []).map(path => path.split(/[\\/]/).pop()!) : answer ? [] : upload.ids();
    const selection = retry ? { ai: retry.to, ...(retry.model ? { model: retry.model } : {}), ...(retry.effort ? { effort: retry.effort } : {}) } : pick.value();
    if (!text && !images.length) {
      toast(t('chat.needText'));
      return;
    }
    await api.send({ project: project.id, task: task.id, text, ...selection, ...(busy ? { mode: mode ?? 'queue' } : {}), answer, images });
    if (!retry) storeLocal(pickKey, pick.value());
    if (!answer && !retry) {
      draft.value = '';
      resizeDraft();
      storeLocal(draftKey, '');
      upload.clear();
    }
    await context.refresh();
  }
  draft.onkeydown = event => {
    if (shouldSend(event, readLocal('yumeewade.enterToSend', false))) {
      event.preventDefault();
      void run(() => send(busy ? 'queue' : undefined));
    }
  };
  function controls(): void {
    if (busy) {
      actions.replaceChildren(
        button(t('chat.stop'), () => request('/api/chat/stop', { project: project.id, task: task.id }), 'danger'),
        button(t('chat.redo'), () => send('redo'), 'danger'),
        button(t('chat.amend'), () => send('amend')),
        button(t('chat.queue'), () => send('queue'), 'primary'),
      );
    } else {
      actions.replaceChildren(button(t('chat.send'), () => send(), 'primary'));
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
      q.append(iconButton('×', `${t('common.remove')}: ${t('chat.next', { n: index + 1 })}`, async () => {
        queue = await request<QueueItem[]>('/api/chat/unqueue', { project: project.id, task: task.id, id: item.id });
        renderQueue();
      }));
      if (!busy && index === 0) {
        q.append(button(
          t('chat.startQueued'),
          () => api.send({ project: project.id, task: task.id, text: '', fromQueue: item.id }),
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
    const before = target === transcriptRows ? live : null;
    if (entry.role === 'event' && entry.tool) {
      if (!toolGroup) {
        toolCount = 0;
        toolGroup = disclosure('');
        toolGroup.className = 'tool-events';
        toolGroup.open = readLocal('yumeewade.tools', false);
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
        metadata.append(el('span', 'error-mark', t(entry.error === 'interrupted' ? 'chat.interrupted' : 'chat.error')));
      }
      item.append(metadata, markdown(entry.text));
    }
    metadata.append(button(t('chat.copy'), async () => {
      try { await copyText(entry.text); toast(t('markdown.copied')); }
      catch { toast(t('markdown.copyFailed')); }
    }, 'copy-message'));
    target.insertBefore(item, before);
  }
  function renderTranscript(): void {
    const top = transcript.scrollTop;
    removeLive();
    toolGroup = null;
    transcriptRows.replaceChildren();
    for (const [offset, entry] of rows.entries()) {
      appendRow(entry, history.start + offset);
    }
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
  async function renderWork(): Promise<void> {
    const serial = ++previewSerial;
    work.replaceChildren();
    if (mergeLeftover.length) {
      const notice = el('div', 'warning merge-leftover');
      notice.setAttribute('role', 'status');
      notice.append(el('p', '', t('copy.leftover')), el('pre', '', mergeLeftover.join('\n')));
      work.append(notice);
    }
    if (task.copyMissing) {
      work.append(
        el('span', 'warning', t('copy.missing')),
        button(
          t('copy.clear'),
          async () => {
            await request('/api/task/copyclear', { project: project.id, task: task.id });
            await context.refresh();
          }
        ));
      return;
    }
    if (!task.copy) return;
    let mergeButton: HTMLButtonElement | null = null;
    if (task.mergeExcluded) {
      work.append(el('span', 'muted', t('copy.excluded')));
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
      work.append(mergeButton);
    }
    work.append(
      button(
        t(task.mergeExcluded ? 'copy.restore' : 'copy.exclude'),
        async () => {
          await request('/api/task/merge-exclusion', { project: project.id, task: task.id, excluded: !task.mergeExcluded });
          await context.refresh();
        }
      ),
      button(
        t('copy.diff'),
        async () => {
          const diff = await api.diff(project.id, task.id);
          const viewer = el('div', 'diff-viewer');
          if (diff.truncated) viewer.append(el('p', 'warning diff-warning', t('copy.truncated')));
          const files = parseDiff(diff.diff);
          if (!files.length) viewer.append(el('p', 'muted', t('copy.noChanges')));
          for (const [index, file] of files.entries()) {
            const section = disclosure('');
            section.className = 'diff-file';
            section.open = index < 3;
            section.querySelector('summary')!.append(el('span', 'diff-path', file.path || t('copy.diff')),
              el('span', 'diff-added', `+${file.added}`), el('span', 'diff-removed', `−${file.removed}`));
            const content = el('pre', 'diff-lines');
            for (const line of file.lines) content.append(el('span', `diff-line diff-${line.kind}`, line.text));
            section.append(content);
            viewer.append(section);
          }
          modal(t('copy.diff'), viewer);
        }
      ));
    const preview = await api.preview(project.id, task.id);
    if (!alive || serial !== previewSerial || !preview) return;
    if (mergeButton) mergeButton.disabled = preview.files === 0;
    work.prepend(el(
      'span',
      'copy-stats',
      preview.files === 0 ? t('copy.noChanges') : t('copy.stats', { files: preview.files, added: preview.added, removed: preview.removed })
    ));
    if (preview.conflict) {
      work.append(disclosure(t('copy.conflict'), el('pre', 'warning', preview.conflictPaths.join('\n'))));
    }
    if (preview.mainDirty) work.append(el('span', 'muted', t('copy.mainDirty')));
  }
  const footer = el('div', 'task-footer');
  function renderFooter(): void {
    const state = select(TASK_STATES.map(value => ({ value, label: t(`state.${value}`) })), task.state);
    state.onchange = () => {
      void run(async () => {
        await request('/api/task/update', { project: project.id, task: task.id, patch: { state: state.value } });
        await context.refresh();
      });
    };
    const phase = select(
      [{ value: '', label: t('common.none') }, ...project.phases.map(p => ({ value: p.name, label: p.name }))],
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
          await request('/api/task/step', { project: project.id, task: task.id, index, done: check.checked });
          await context.refresh();
        });
      };
      steps.append(row(
        field(step.text, check),
        iconButton('×', `${t('common.remove')}: ${step.text}`, async () => {
          await request('/api/task/step', { project: project.id, task: task.id, remove: index });
          await context.refresh();
        }),
      ));
    });
    const add = input('', t('task.addStep'));
    steps.append(row(
      add,
      button(
        t('common.add'),
        async () => {
          if (!add.value.trim()) return;
          await request('/api/task/step', { project: project.id, task: task.id, add: add.value.trim() });
          await context.refresh();
        }
      )
    ));
    const detail = disclosure(t('task.steps', { done: task.steps.filter(s => s.done).length, total: task.steps.length }), steps);
    detail.open = footer.querySelector('details')?.open ?? false;
    state.setAttribute('aria-label', t('task.state'));
    state.title = t('task.state');
    phase.setAttribute('aria-label', t('task.phase'));
    phase.title = t('task.phase');
    const memo = input('', t('task.memo'));
    memo.maxLength = 300;
    memo.setAttribute('aria-label', t('task.memo'));
    const leaveMemo = button(
      t('task.leaveMemo'),
      async () => {
        if (!memo.value.trim()) return;
        await request('/api/task/memo', { project: project.id, task: task.id, text: memo.value.trim() });
        await context.refresh();
      });
    footer.title = task.memo;
    footer.replaceChildren(row(state, phase, detail, memo, leaveMemo));
  }
  const composerControls = row(pick.node, upload.node, actions);
  composerControls.classList.add('composer-controls');
  composer.append(queueNode, draft, upload.strip, running, composerControls);
  node.append(header, transcript, latest, composer, footer);
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
        appendRow(event.data, history.start + rows.length - 1);
        renderQuestion();
        follow();
        break;
      case 'queue':
        queue = event.data;
        renderQueue();
        break;
      case 'idle':
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
  for (const event of ['snapshot', 'busy', 'delta', 'row', 'queue', 'idle'] as const) {
    listeners[event] = message => {
      try {
        receive({ event, data: JSON.parse(message.data) } as ChatEvent);
      } catch {
        /* 無效 SSE 不改畫面；重連 snapshot 可恢復。 */
      }
    };
  }
  const source = stream(query('/api/chat/stream', { project: project.id, task: task.id }), listeners);
  const timer = window.setInterval(clock, 1000);
  void run(() => request('/api/task/read', { project: project.id, task: task.id }));
  return {
    node,
    dispose: () => {
      alive = false;
      source.close();
      removeLive();
      window.clearInterval(timer);
      cancelAnimationFrame(resizeFrame);
      upload.dispose();
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
      ]) !== JSON.stringify([
        nextTask.copy, nextTask.copyMissing, nextTask.mergeExcluded, nextTask.workdir, nextTask.updated,
      ]);
      const footerChanged = JSON.stringify([
        task.state, task.phase, task.steps, task.memo,
      ]) !== JSON.stringify([
        nextTask.state, nextTask.phase, nextTask.steps, nextTask.memo,
      ]);
      project = nextProject;
      task = nextTask;
      stateChip.textContent = t(`state.${task.state}`);
      if (document.activeElement !== title) title.value = task.title;
      renderQuestion();
      updateHeaderActions();
      if (footerChanged) renderFooter();
      if (workChanged) void run(renderWork);
    },
  };
}
