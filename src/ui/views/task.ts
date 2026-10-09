import type { AppState, Busy, ChatEvent, ChatRow, ProjectView, QueueItem, SendMode, TaskView } from '../../shared/types.ts';
import { TASK_STATES } from '../../shared/types.ts';
import { api, query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { attachments } from '../components/attachments.ts';
import { aiPicker } from '../components/picker.ts';
import { markdown } from '../components/markdown.ts';
import { area, button, confirmModal, disclosure, el, field, input, link, modal, projectHash, readLocal, row, run, select, storeLocal, toast, type View, type ViewContext } from '../components/dom.ts';
import { aiLabel, effortLabel, localTime, modelLabel } from '../components/display.ts';
import { shouldSend } from '../components/composer.ts';
import { stream } from '../components/stream.ts';

export function taskView(context: ViewContext, initialProject: ProjectView, initialTask: TaskView): View {
  let project = initialProject; let task = initialTask; let alive = true;
  let rows: ChatRow[] = []; let busy: Busy | null = null; let partial = ''; let queue: QueueItem[] = []; let following = true;
  const node = el('div', 'task-page'); const header = el('header', 'task-header'); const work = el('div', 'work-info');
  const title = input(task.title); title.className = 'title-input'; title.maxLength = 80; title.setAttribute('aria-label', t('task.titleEdit'));
  title.onchange = () => { void run(async () => { await request('/api/task/update', { project: project.id, task: task.id, patch: { title: title.value.trim() } }); await context.refresh(); }); };
  const stateChip = el('span', 'state-chip', t(`state.${task.state}`));
  header.append(link(t('common.back', { name: project.name }), projectHash(project.id), 'back-link'), row(title, stateChip, button(t('common.open'), () => request('/api/open', { path: task.workdir || project.bodyPath }))), work);
  const transcript = el('div', 'transcript'); transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-live', 'polite');
  const transcriptRows = el('div', 'transcript-rows');
  const latest = button(t('chat.latest'), () => { following = true; transcript.scrollTop = transcript.scrollHeight; latest.hidden = true; }, 'latest'); latest.hidden = true;
  transcript.onscroll = () => { following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80; latest.hidden = following; };
  const question = el('div', 'question-area'); const queueNode = el('div', 'queue-strip'); const composer = el('div', 'composer');
  transcript.append(transcriptRows, question);
  const draftKey = `yumeewade.draft.${project.id}/${task.id}`; const pickKey = `yumeewade.pick.${project.id}/${task.id}`;
  const draft = area(readLocal<string>(draftKey, ''), t(readLocal('yumeewade.enterToSend', false) ? 'chat.placeholderEnter' : 'chat.placeholder')); draft.maxLength = context.state.limits.promptChars;
  draft.rows = 2;
  function resizeDraft(): void { draft.style.height = 'auto'; draft.style.height = `${Math.min(208, Math.max(48, draft.scrollHeight))}px`; }
  draft.oninput = () => { storeLocal(draftKey, draft.value); resizeDraft(); };
  const initialPick = readLocal(pickKey, { ai: task.cli || context.state.settings.initial.ai, model: task.model || context.state.settings.initial.model, effort: task.effort || context.state.settings.initial.effort });
  const pick = aiPicker(context.state, initialPick, value => storeLocal(pickKey, value), false, true); const upload = attachments(project.id, context.state.limits, draft);
  const actions = el('div', 'send-actions'); const running = el('p', 'running-line');
  async function send(mode?: SendMode, text = draft.value.trim(), answer = false): Promise<void> {
    await upload.ready();
    if (!text && !upload.ids().length) { toast(t('chat.needText')); return; }
    await api.send({ project: project.id, task: task.id, text, ...pick.value(), ...(busy ? { mode: mode ?? 'queue' } : {}), answer, images: answer ? [] : upload.ids() });
    storeLocal(pickKey, pick.value()); if (!answer) { draft.value = ''; resizeDraft(); storeLocal(draftKey, ''); upload.clear(); } await context.refresh();
  }
  draft.onkeydown = event => { if (shouldSend(event, readLocal('yumeewade.enterToSend', false))) { event.preventDefault(); void run(() => send(busy ? 'queue' : undefined)); } };
  function controls(): void {
    if (busy) actions.replaceChildren(button(t('chat.stop'), () => request('/api/chat/stop', { project: project.id, task: task.id }), 'danger'), button(t('chat.redo'), () => send('redo'), 'danger'), button(t('chat.amend'), () => send('amend')), button(t('chat.queue'), () => send('queue'), 'primary'));
    else actions.replaceChildren(button(t('chat.send'), () => send(), 'primary'));
    clock(); renderQueue();
  }
  function clock(): void {
    if (!busy) { running.textContent = ''; running.hidden = true; return; }
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(busy.startedAt)) / 1000)); const time = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
    running.hidden = false; running.textContent = t('chat.running', { ai: aiLabel(busy.ai), model: modelLabel(context.state, busy.ai, busy.model), time });
    const timer = transcript.querySelector<HTMLElement>('.live-time'); if (timer) timer.textContent = time;
  }
  function renderQueue(): void {
    queueNode.replaceChildren(...queue.map((item, index) => {
      const q = el('div', 'queue-item'); q.append(el('strong', '', t('chat.next', { n: index + 1 })), el('span', 'queue-text', item.text), el('span', 'muted', `${aiLabel(item.ai)} · ${modelLabel(context.state, item.ai, item.model)} · ${effortLabel(item.effort)}`));
      if (item.error) q.append(el('span', 'error-mark', t('chat.error')));
      q.append(button('×', async () => { queue = await request<QueueItem[]>('/api/chat/unqueue', { project: project.id, task: task.id, id: item.id }); renderQueue(); }));
      if (!busy && index === 0) q.append(button(t('chat.startQueued'), () => api.send({ project: project.id, task: task.id, text: '', fromQueue: item.id }), 'primary')); return q;
    })); queueNode.hidden = !queue.length;
  }
  let live: HTMLElement | null = null; let liveBody: HTMLElement | null = null; let liveFrame = 0; let toolGroup: HTMLDetailsElement | null = null; let toolCount = 0;
  function follow(): void { if (following) transcript.scrollTop = transcript.scrollHeight; latest.hidden = following; }
  function removeLive(): void { cancelAnimationFrame(liveFrame); liveFrame = 0; live?.remove(); live = null; liveBody = null; }
  function addLive(): void {
    removeLive(); if (!busy) return;
    live = el('article', 'chat-card assistant live'); liveBody = markdown(partial || '…');
    live.append(row(el('span', 'dot running'), el('strong', '', `${aiLabel(busy.ai)} · ${modelLabel(context.state, busy.ai, busy.model)} · ${effortLabel(busy.effort)}`), el('span', 'live-time')), liveBody); transcriptRows.append(live); clock(); follow();
  }
  function appendRow(entry: ChatRow): void {
      if (entry.role === 'event' && entry.tool) {
        if (!toolGroup) { toolCount = 0; toolGroup = disclosure(''); toolGroup.className = 'tool-events'; toolGroup.open = readLocal('yumeewade.tools', false); transcriptRows.insertBefore(toolGroup, live); }
        toolGroup.querySelector('summary')!.textContent = t('chat.tools', { n: ++toolCount }); toolGroup.append(el('pre', 'tool-row', entry.text)); return;
      }
      toolGroup = null;
      if (entry.role === 'event') { transcriptRows.insertBefore(el('div', 'event-row', entry.text), live); return; }
      const item = el('article', `chat-card ${entry.role}`); const metadata = el('div', 'chat-meta');
      if (entry.role === 'user') {
        metadata.append(el('strong', '', t('chat.you')), el('time', '', localTime(entry.at)), el('span', '', `→ ${aiLabel(entry.to)} · ${modelLabel(context.state, entry.to, entry.model)} · ${effortLabel(entry.effort)}`));
        if (entry.mode) metadata.append(el('span', 'mode-tag', t(`chat.mode.${entry.mode}`)));
        item.append(metadata, el('p', 'user-text', entry.text));
        if (entry.images?.length) {
          const images = el('div', 'image-strip');
          for (const path of entry.images) {
            const name = path.split(/[\\/]/).pop() ?? '';
            const img = el('img', 'transcript-image');
            img.src = query('/api/attachment', { project: project.id, task: task.id, name }); img.alt = name;
            const preview = button('', () => { const full = el('img', 'full-image'); full.src = img.src; full.alt = name; modal(name, full); }, 'image-preview');
            preview.setAttribute('aria-label', name); preview.append(img); images.append(preview);
          }
          item.append(images);
        }
      } else {
        metadata.append(el('strong', '', aiLabel(entry.ai)), el('span', '', `${modelLabel(context.state, entry.ai, entry.model)} · ${effortLabel(entry.effort)}`), el('time', '', localTime(entry.at)), el('span', '', t('chat.duration', { seconds: Math.round(entry.ms / 1000) })));
        if (entry.stopped) metadata.append(el('span', 'stopped-mark', t('chat.stopped'))); if (entry.error) metadata.append(el('span', 'error-mark', t(entry.error === 'interrupted' ? 'chat.interrupted' : 'chat.error')));
        item.append(metadata, markdown(entry.text));
      }
      transcriptRows.insertBefore(item, live);
  }
  function renderTranscript(): void {
    const top = transcript.scrollTop; removeLive(); toolGroup = null; transcriptRows.replaceChildren();
    for (const entry of rows) appendRow(entry);
    addLive(); renderQuestion(); if (!following) transcript.scrollTop = top; follow();
  }
  function renderQuestion(): void {
    // 重畫串流文字不應吃掉使用者正在輸入的答案；問題內容沒變就保留 DOM。
    const lastAssistant = [...rows].reverse().find((entry): entry is Extract<ChatRow, { role: 'assistant' }> => entry.role === 'assistant' && !!entry.asks?.length);
    const asks = lastAssistant?.asks ?? []; const key = task.question ? JSON.stringify([task.question, asks]) : '';
    if (question.dataset['key'] === key) return; question.dataset['key'] = key; question.replaceChildren();
    if (!task.question) return;
    const panel = el('div', 'question-card'); panel.append(el('h3', '', t('chat.question')));
    const answerParts: string[][] = asks.map(() => []);
    if (asks.length) for (const [i, ask] of asks.entries()) {
      const group = el('div', 'question-group'); group.append(el('p', '', ask.question));
      if (ask.multi) { for (const option of ask.options) { const check = input(); check.type = 'checkbox'; check.onchange = () => { answerParts[i] = Array.from(group.querySelectorAll<HTMLInputElement>('input:checked')).map(c => c.value); }; check.value = option; group.append(field(option, check)); } }
      else for (const option of ask.options) group.append(button(option, () => send(busy ? 'queue' : undefined, option, true), 'option-button'));
      panel.append(group);
    } else panel.append(el('p', '', task.question));
    const free = area('', t('chat.freeAnswer'));
    panel.append(free, row(button(t('chat.send'), async () => { const answers = answerParts.flat(); if (free.value.trim()) answers.push(free.value.trim()); await send(busy ? 'queue' : undefined, answers.join('\n'), true); }), button(t('chat.clearQuestion'), async () => { await request('/api/task/update', { project: project.id, task: task.id, patch: { question: '' } }); await context.refresh(); }, 'subtle'))); question.append(panel);
    if (following) transcript.scrollTop = transcript.scrollHeight;
  }
  let previewSerial = 0;
  async function renderWork(): Promise<void> {
    const serial = ++previewSerial; work.replaceChildren();
    if (task.copyMissing) { work.append(el('span', 'warning', t('copy.missing')), button(t('copy.clear'), async () => { await request('/api/task/copyclear', { project: project.id, task: task.id }); await context.refresh(); })); return; }
    if (!task.copy) return;
    let mergeButton: HTMLButtonElement | null = null;
    if (task.mergeExcluded) work.append(el('span', 'muted', t('copy.excluded')));
    else {
      mergeButton = button(t('copy.merge'), async () => {
        if (!await confirmModal(t('copy.merge'), t('copy.confirmMerge'), t('copy.merge'))) return;
        const result = await api.merge(project.id, task.id);
        if (result.conflicts?.length) modal(t('copy.conflict'), el('pre', '', result.conflicts.join('\n')));
        else toast(t('copy.merged'));
        await context.refresh();
      }, 'primary');
      mergeButton.disabled = true; work.append(mergeButton);
    }
    work.append(button(t(task.mergeExcluded ? 'copy.restore' : 'copy.exclude'), async () => { await request('/api/task/merge-exclusion', { project: project.id, task: task.id, excluded: !task.mergeExcluded }); await context.refresh(); }), button(t('copy.diff'), async () => { const diff = await api.diff(project.id, task.id); modal(t('copy.diff'), el('pre', 'diff', diff.diff), ...(diff.truncated ? [el('p', 'warning', t('copy.truncated'))] : [])); }));
    const preview = await api.preview(project.id, task.id); if (!alive || serial !== previewSerial || !preview) return;
    if (mergeButton) mergeButton.disabled = preview.files === 0;
    work.prepend(el('span', 'copy-stats', preview.files === 0 ? t('copy.noChanges') : t('copy.stats', { files: preview.files, added: preview.added, removed: preview.removed })));
    if (preview.conflict) work.append(disclosure(t('copy.conflict'), el('pre', 'warning', preview.conflictPaths.join('\n')))); if (preview.mainDirty) work.append(el('span', 'muted', t('copy.mainDirty')));
  }
  const footer = el('div', 'task-footer');
  function renderFooter(): void {
    const state = select(TASK_STATES.map(value => ({ value, label: t(`state.${value}`) })), task.state);
    state.onchange = () => { void run(async () => { await request('/api/task/update', { project: project.id, task: task.id, patch: { state: state.value } }); await context.refresh(); }); };
    const phase = select([{ value: '', label: t('common.none') }, ...project.phases.map(p => ({ value: p.name, label: p.name }))], task.phase);
    phase.onchange = () => { void run(async () => { await request('/api/task/update', { project: project.id, task: task.id, patch: { phase: phase.value } }); await context.refresh(); }); };
    const steps = el('div', 'step-list'); task.steps.forEach((step, index) => { const check = input(); check.type = 'checkbox'; check.checked = step.done; check.onchange = () => { void run(async () => { await request('/api/task/step', { project: project.id, task: task.id, index, done: check.checked }); await context.refresh(); }); }; steps.append(row(field(step.text, check), button('×', async () => { await request('/api/task/step', { project: project.id, task: task.id, remove: index }); await context.refresh(); }))); });
    const add = input('', t('task.addStep')); steps.append(row(add, button(t('common.add'), async () => { if (!add.value.trim()) return; await request('/api/task/step', { project: project.id, task: task.id, add: add.value.trim() }); await context.refresh(); })));
    const detail = disclosure(t('task.steps', { done: task.steps.filter(s => s.done).length, total: task.steps.length }), steps); detail.open = footer.querySelector('details')?.open ?? false;
    state.setAttribute('aria-label', t('task.state')); state.title = t('task.state');
    phase.setAttribute('aria-label', t('task.phase')); phase.title = t('task.phase');
    const memo = input('', t('task.memo')); memo.maxLength = 300; memo.setAttribute('aria-label', t('task.memo'));
    const leaveMemo = button(t('task.leaveMemo'), async () => {
      if (!memo.value.trim()) return;
      await request('/api/task/memo', { project: project.id, task: task.id, text: memo.value.trim() }); await context.refresh();
    });
    footer.title = task.memo;
    footer.replaceChildren(row(state, phase, detail, memo, leaveMemo));
  }
  const composerControls = row(pick.node, upload.node, actions); composerControls.classList.add('composer-controls');
  composer.append(queueNode, draft, upload.strip, running, composerControls);
  node.append(header, transcript, latest, composer, footer); controls(); renderFooter(); void run(renderWork);
  const resizeFrame = requestAnimationFrame(resizeDraft);
  function receive(event: ChatEvent): void {
    switch (event.event) {
      case 'snapshot': rows = event.data.rows; busy = event.data.busy; partial = event.data.partial; queue = event.data.queue; renderTranscript(); controls(); break;
      case 'busy': busy = event.data; partial = ''; addLive(); controls(); break;
      case 'delta': if (busy?.request === event.data.request) {
        partial += event.data.text;
        if (!liveFrame) liveFrame = requestAnimationFrame(() => { liveFrame = 0; if (!liveBody) return; const next = markdown(partial || '…'); liveBody.replaceWith(next); liveBody = next; follow(); });
      } break;
      case 'row': rows.push(event.data); if (event.data.role === 'assistant' && event.data.request === busy?.request) { partial = ''; removeLive(); } appendRow(event.data); renderQuestion(); follow(); break;
      case 'queue': queue = event.data; renderQueue(); break;
      case 'idle': if (busy?.request === event.data.request) { busy = null; partial = ''; removeLive(); } controls(); follow(); void context.refresh(); void run(renderWork); break;
    }
  }
  const listeners: Record<string, (message: MessageEvent<string>) => void> = {};
  for (const event of ['snapshot', 'busy', 'delta', 'row', 'queue', 'idle'] as const) listeners[event] = message => { try { receive({ event, data: JSON.parse(message.data) } as ChatEvent); } catch { /* 無效 SSE 不改畫面；重連 snapshot 可恢復。 */ } };
  const source = stream(query('/api/chat/stream', { project: project.id, task: task.id }), listeners);
  const timer = window.setInterval(clock, 1000); void run(() => request('/api/task/read', { project: project.id, task: task.id }));
  return { node, dispose: () => { alive = false; source.close(); removeLive(); window.clearInterval(timer); cancelAnimationFrame(resizeFrame); upload.dispose(); }, update: (state: AppState) => {
    context.state = state; const nextProject = state.projects.find(p => p.id === project.id); const nextTask = nextProject?.tasks.find(t => t.id === task.id); if (!nextProject || !nextTask) { location.hash = projectHash(project.id); return; }
    const workChanged = JSON.stringify([task.copy, task.copyMissing, task.mergeExcluded, task.workdir, task.updated]) !== JSON.stringify([nextTask.copy, nextTask.copyMissing, nextTask.mergeExcluded, nextTask.workdir, nextTask.updated]);
    const footerChanged = JSON.stringify([task.state, task.phase, task.steps, task.memo]) !== JSON.stringify([nextTask.state, nextTask.phase, nextTask.steps, nextTask.memo]);
    project = nextProject; task = nextTask; stateChip.textContent = t(`state.${task.state}`); if (document.activeElement !== title) title.value = task.title;
    renderQuestion(); if (footerChanged) renderFooter(); if (workChanged) void run(renderWork);
  } };
}
