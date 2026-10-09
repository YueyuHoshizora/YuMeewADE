// YuMeewADE 前端：三欄（專案／作業／對話）。vanilla TypeScript，狀態集中在 state 物件，畫面以函式重繪。
// 兩條 SSE：全域流（作業／專案變更 → 清單即時更新）、作業流（對話）。

import type { Bootstrap, ChatRow, Project, ProjectStatus, QueueItem, RunState, Task, TaskPatch, TaskState, WorktreeStatus } from '../shared/types.ts';
import { EFFORTS, PROJECT_STATUSES, TASK_STATES } from '../shared/types.ts';
import { api, ApiFailure } from './api.ts';
import { applyStatic, getLocale, LOCALES, localeName, setLocale, t as i, type Locale } from './i18n/index.ts';
import type { MessageKey } from './i18n/zh-TW.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const state = {
  boot: null as Bootstrap | null,
  project: '' as string,
  tasks: [] as Task[],
  task: null as Task | null,
  log: [] as ChatRow[],
  running: null as RunState | null,
  stopping: false,
  partial: '',
  queue: [] as QueueItem[],
  worktree: null as WorktreeStatus | null,
  stream: null as EventSource | null,
  global: null as EventSource | null,
};

// ---- 小工具 ----
let toastTimer: number | undefined;
function toast(msg: string): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiFailure) {
      // detail 代碼可翻譯；沒有 detail 就顯示錯誤碼的 generic 訊息
      const text = err.detail ? i(`detail.${err.detail}` as MessageKey, { field: err.field ?? '' }) : i(`err.${err.code}` as MessageKey);
      toast(`${err.status}：${text}`);
    } else toast(i('err.network'));
    return undefined;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

function fillSelect(select: HTMLSelectElement, options: Option[], keep = true): void {
  const prev = select.value;
  select.replaceChildren(
    ...options.map((o) => {
      const opt = el('option', { value: o.value }, o.label);
      if (o.disabled) opt.disabled = true;
      return opt;
    }),
  );
  if (keep && options.some((o) => o.value === prev)) select.value = prev;
}

const parseEvent = <T>(e: Event): T => JSON.parse((e as MessageEvent).data as string) as T;

// ---- 專案欄 ----

function renderProjects(): void {
  const boot = state.boot;
  if (!boot) return;
  $('version').textContent = ` v${boot.version}`;
  $('workspace-root').textContent = boot.workspaceRoot;
  const ul = $('project-list');
  ul.replaceChildren(
    ...boot.projects.map((p) => {
      const li = el('li', { class: p.name === state.project ? 'active' : '' });
      li.append(el('div', {}, p.name));
      const sub = el('div', { class: 'sub' });
      const status = el('select', { class: 'inline' });
      fillSelect(status, PROJECT_STATUSES.map((s) => ({ value: s, label: i(`state.${s}` as MessageKey) })), false);
      status.value = p.status;
      status.onclick = (e) => e.stopPropagation();
      status.onchange = async (e) => {
        e.stopPropagation();
        const updated = await guard(api.updateProject(p.name, { status: status.value as ProjectStatus }));
        if (updated) applyProject(updated);
        else status.value = p.status;
      };
      const archive = el('button', { type: 'button', class: 'inline danger' }, i('app.archiveProject'));
      archive.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(i('app.confirmArchiveProject', { name: p.name }))) return;
        if (await guard(api.archiveProject(p.name))) {
          if (state.project === p.name) location.reload();
          else await reloadBootstrap();
        }
      };
      sub.append(status, el('span', {}, p.updated), archive);
      li.append(sub);
      li.onclick = () => void selectProject(p.name);
      return li;
    }),
  );
  fillSelect(
    $('task-role'),
    [{ value: '', label: i('app.roleNone') }, ...Object.entries(boot.roles.roles).map(([name, r]) => ({ value: name, label: i('app.roleOption', { name, cli: r.main.cli }) }))],
  );
}

function applyProject(p: Project): void {
  if (!state.boot) return;
  const idx = state.boot.projects.findIndex((x) => x.name === p.name);
  if (idx >= 0) state.boot.projects[idx] = p;
  else state.boot.projects.push(p);
  renderProjects();
}

async function reloadBootstrap(): Promise<void> {
  const boot = await guard(api.bootstrap());
  if (!boot) return;
  state.boot = boot;
  renderProjects();
  renderComposerOptions();
}

async function selectProject(name: string): Promise<void> {
  state.project = name;
  renderProjects();
  $('tasks-title').textContent = i('app.tasksOf', { name });
  await reloadTasks();
}

// ---- 作業欄 ----

async function reloadTasks(): Promise<void> {
  if (!state.project) return;
  const tasks = await guard(api.tasks(state.project));
  if (!tasks) return;
  state.tasks = tasks;
  if (state.task) state.task = tasks.find((x) => x.id === state.task?.id) ?? null;
  renderTasks();
}

/** 全域流送來某個作業的新狀態：更新清單；若正是目前作業也更新標頭。 */
function applyTask(project: string, task: Task): void {
  if (project !== state.project) return;
  const idx = state.tasks.findIndex((x) => x.id === task.id);
  if (idx >= 0) state.tasks[idx] = task;
  else state.tasks.unshift(task);
  renderTasks();
  if (state.task?.id === task.id) {
    state.task = task;
    renderTaskHeader();
  }
}

function renderTasks(): void {
  const ul = $('task-list');
  ul.replaceChildren(
    ...state.tasks.map((task) => {
      const li = el('li', { class: task.id === state.task?.id ? 'active' : '' });
      li.append(el('div', {}, task.title || i('app.untitled')));
      const sub = el('div', { class: 'sub' });
      sub.append(el('span', { class: `badge ${task.state}` }, i(`state.${task.state}` as MessageKey)), el('span', {}, task.id));
      if (task.steps.total) sub.append(el('span', {}, `${task.steps.done}/${task.steps.total}`));
      if (task.question) sub.append(el('span', { class: 'badge 等待回覆' }, i('app.yourTurn')));
      li.append(sub);
      li.onclick = () => void selectTask(task);
      return li;
    }),
  );
}

// ---- 對話欄 ----

async function selectTask(task: Task): Promise<void> {
  state.task = task;
  state.log = [];
  state.partial = '';
  state.running = null;
  state.stopping = false;
  state.queue = [];
  state.worktree = null;
  renderTasks();
  $('chat-header').classList.remove('hidden');
  $('chat-empty').classList.add('hidden');
  $('chat-log').classList.remove('hidden');
  $('composer').classList.remove('hidden');
  renderTaskHeader();
  renderComposerOptions();
  await Promise.all([reloadLog(), reloadWorktree()]);
  openStream();
}

async function reloadLog(): Promise<void> {
  if (!state.task) return;
  const log = await guard(api.chatLog(state.project, state.task.id));
  if (log) {
    state.log = log;
    renderLog(true);
  }
}

function modelOptionsFor(cli: string): Option[] {
  const models = cli ? (state.boot?.roles.models[cli] ?? []) : [];
  return models.filter((m) => m !== 'default').map((m) => ({ value: m, label: m }));
}

function renderTaskHeader(): void {
  const task = state.task;
  const boot = state.boot;
  if (!task || !boot) return;
  $('chat-title').textContent = `${task.id}　${task.title}`;
  const sel = $<HTMLSelectElement>('task-state');
  fillSelect(sel, TASK_STATES.map((s) => ({ value: s, label: i(`state.${s}` as MessageKey) })), false);
  sel.value = task.state;
  $('task-steps').textContent = task.steps.total ? i('app.steps', { done: task.steps.done, total: task.steps.total }) : '';
  const allDone = task.steps.total > 0 && task.steps.done === task.steps.total && task.state !== '完成';
  $('task-complete').classList.toggle('hidden', !allDone);

  const role = $<HTMLSelectElement>('task-role-edit');
  fillSelect(role, [{ value: '', label: i('app.roleNone') }, ...Object.keys(boot.roles.roles).map((name) => ({ value: name, label: i('app.fieldRole', { value: name }) }))], false);
  role.value = task.role;
  const cli = $<HTMLSelectElement>('task-cli-edit');
  fillSelect(cli, [{ value: '', label: i('app.fieldCliInherit') }, ...boot.clis.map((c) => ({ value: c.name, label: i('app.fieldCli', { value: c.name }) }))], false);
  cli.value = task.cli;
  const model = $<HTMLSelectElement>('task-model-edit');
  const effectiveCli = task.cli || boot.roles.roles[task.role]?.main.cli || '';
  fillSelect(model, [{ value: '', label: i('app.fieldModelInherit') }, ...modelOptionsFor(effectiveCli).map((o) => ({ ...o, label: i('app.fieldModel', { value: o.value }) }))], false);
  model.value = task.model;
  const effort = $<HTMLSelectElement>('task-effort-edit');
  fillSelect(effort, [{ value: '', label: i('app.fieldEffortInherit') }, ...EFFORTS.map((e) => ({ value: e, label: i('app.fieldEffort', { value: e }) }))], false);
  effort.value = task.effort;

  $('task-meta').textContent = [task.owner && i('app.metaOwner', { owner: task.owner }), task.phase && i('app.metaPhase', { phase: task.phase }), i('app.metaUpdated', { updated: task.updated })]
    .filter(Boolean)
    .join('　');
  const q = $('task-question');
  q.textContent = task.question ? i('app.yourTurnQuestion', { question: task.question }) : '';
  q.classList.toggle('hidden', !task.question);
}

function renderComposerOptions(): void {
  const boot = state.boot;
  if (!boot) return;
  const task = state.task;
  const role = task?.role ? boot.roles.roles[task.role] : undefined;
  const defaultCli = task?.cli || role?.main.cli || '';
  fillSelect(
    $('composer-cli'),
    [
      { value: '', label: defaultCli ? i('app.cliDefaultWith', { cli: defaultCli }) : i('app.cliDefault') },
      ...boot.clis.map((c) => ({ value: c.name, label: `${c.name}${c.available ? '' : i('app.notInstalled')}${c.dangerous ? '⚠' : ''}`, disabled: !c.available })),
    ],
  );
  renderModelOptions();
}

function renderModelOptions(): void {
  fillSelect($('composer-model'), [{ value: '', label: i('app.modelDefault') }, ...modelOptionsFor($<HTMLSelectElement>('composer-cli').value)]);
}

function rowNode(r: ChatRow): HTMLElement {
  const node = el('div', { class: `msg ${r.role}` });
  const who = r.role === 'user' ? i('app.you') : r.role === 'assistant' ? `${i('app.ai', { cli: r.cli })}${r.model ? ` · ${r.model}` : ''}` : i('app.error');
  const flag = r.cancelled ? i('app.cancelled') : r.interrupted ? i('app.interrupted') : '';
  node.append(el('div', { class: 'meta' }, `${who} ${flag} ${new Date(r.at).toLocaleString()}`), document.createTextNode(r.text));
  return node;
}

/**
 * 對話區：full=true 整個重繪；否則只補上新列與更新串流中的那一段（高頻 delta 不重繪全部）。
 */
let renderedRows = 0;
let partialNode: HTMLElement | null = null;
function renderLog(full = false): void {
  const box = $('chat-log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  // 串流節點先拿掉，新列補在後面，再視需要掛回最後
  const partial = partialNode ?? el('div', { class: 'msg assistant partial' });
  if (!partialNode) partial.append(el('div', { class: 'meta' }), document.createTextNode(''));
  partial.remove();
  if (full || renderedRows > state.log.length) {
    box.replaceChildren(...state.log.map(rowNode));
    renderedRows = state.log.length;
  } else {
    for (; renderedRows < state.log.length; renderedRows++) box.append(rowNode(state.log[renderedRows] as ChatRow));
  }
  if (state.running) {
    (partial.firstChild as HTMLElement).textContent = state.stopping ? i('app.stopping') : i('app.running', { cli: state.running.cli });
    (partial.lastChild as Text).data = state.partial;
    box.append(partial);
    partialNode = partial;
  } else partialNode = null;
  if (atBottom || state.running) box.scrollTop = box.scrollHeight;
  $<HTMLButtonElement>('composer-stop').disabled = !state.running || state.stopping;
  $<HTMLButtonElement>('composer-cancel-resend').disabled = !state.running || state.stopping;
  $('status').textContent = state.running ? (state.stopping ? i('app.stopping') : i('app.runningStatus', { cli: state.running.cli })) : '';
}

function renderQueue(): void {
  const box = $('queue');
  box.classList.toggle('hidden', state.queue.length === 0);
  box.replaceChildren(
    el('div', { class: 'muted' }, i('app.queueTitle', { n: state.queue.length })),
    ...state.queue.map((q) => {
      const item = el('div', { class: 'item' });
      const rm = el('button', { type: 'button' }, i('app.remove'));
      rm.onclick = () => void guard(api.removeQueued(state.project, state.task?.id ?? '', q.request));
      item.append(el('span', {}, `${q.cli}：${q.text}`), rm);
      return item;
    }),
  );
}

// ---- SSE ----

function openGlobalStream(): void {
  state.global?.close();
  const es = new EventSource(api.eventsUrl());
  state.global = es;
  es.addEventListener('task', (e) => {
    const d = parseEvent<{ project: string; task: Task }>(e);
    applyTask(d.project, d.task);
  });
  es.addEventListener('project', (e) => applyProject(parseEvent<Project>(e)));
}

function openStream(): void {
  state.stream?.close();
  if (!state.task) return;
  const task = state.task.id;
  const es = new EventSource(api.streamUrl(state.project, task));
  state.stream = es;
  es.addEventListener('ready', (e) => {
    const d = parseEvent<{ running: RunState | null; partial: string; queue: QueueItem[]; task: Task | null }>(e);
    state.running = d.running;
    state.stopping = false;
    state.partial = d.partial;
    state.queue = d.queue;
    if (d.task) {
      state.task = d.task;
      renderTaskHeader();
    }
    renderQueue();
    // 重連後補歷史
    void reloadLog();
  });
  es.addEventListener('log', (e) => {
    const row = parseEvent<ChatRow>(e);
    state.log.push(row);
    // user 列代表一輪開始（含出隊執行）；其他列代表本輪輸出已落檔
    if (row.role === 'user') {
      state.running = { request: row.request, cli: row.cli, ...(row.model ? { model: row.model } : {}), startedAt: row.at };
      state.stopping = false;
      state.partial = '';
    } else state.partial = '';
    renderLog();
  });
  es.addEventListener('delta', (e) => {
    const d = parseEvent<{ request: string; text: string }>(e);
    if (!state.running) state.running = { request: d.request, cli: '?', startedAt: '' };
    state.partial += d.text;
    renderLog();
  });
  es.addEventListener('done', () => {
    state.running = null;
    state.stopping = false;
    state.partial = '';
    renderLog();
    void reloadWorktree();
  });
  es.addEventListener('error', (e) => {
    if ((e as MessageEvent).data) toast(i('app.cliFailed'));
    else $('status').textContent = i('app.disconnected');
  });
  es.addEventListener('queue', (e) => {
    state.queue = parseEvent<QueueItem[]>(e);
    renderQueue();
  });
  es.addEventListener('task', (e) => applyTask(state.project, parseEvent<Task>(e)));
}

// ---- worktree ----

async function reloadWorktree(): Promise<void> {
  if (!state.task) return;
  const wt = await guard(api.worktreeStatus(state.project, state.task.id));
  if (!wt) {
    $('worktree').replaceChildren();
    return;
  }
  state.worktree = wt;
  renderWorktree();
}

function renderWorktree(): void {
  const box = $('worktree');
  const wt = state.worktree;
  const task = state.task;
  if (!wt || !task) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren();
  if (!wt.exists) {
    const btn = el('button', { type: 'button' }, i('wt.create'));
    btn.onclick = async () => {
      if (await guard(api.worktreeCreate(state.project, task.id))) await reloadWorktree();
    };
    box.append(el('span', { class: 'muted' }, i('wt.none')), btn);
    return;
  }
  box.append(el('span', { class: 'muted' }, i('wt.summary', { branch: wt.branch, dirty: wt.dirty.length, ahead: wt.ahead })));
  const diffBtn = el('button', { type: 'button' }, i('wt.diff'));
  const mergeBtn = el('button', { type: 'button', class: 'primary' }, i('wt.merge'));
  const rmBtn = el('button', { type: 'button', class: 'danger' }, i('wt.remove'));
  const pre = el('pre', { class: 'diff hidden' });
  diffBtn.onclick = async () => {
    if (!pre.classList.contains('hidden')) {
      pre.classList.add('hidden');
      return;
    }
    const d = await guard(api.worktreeDiff(state.project, task.id));
    if (!d) return;
    pre.textContent = (d.diff || i('wt.noDiff')) + (d.truncated ? '\n' + i('wt.truncated') : '');
    pre.classList.remove('hidden');
  };
  mergeBtn.onclick = async () => {
    if (!confirm(i('wt.confirmMerge', { branch: wt.branch }))) return;
    const r = await guard(api.worktreeMerge(state.project, task.id));
    if (!r) return;
    toast(r.merged ? i('wt.merged', { commit: r.commit ?? '' }) : i('wt.conflict', { files: (r.conflicts ?? []).join(', ') }));
    await reloadWorktree();
  };
  rmBtn.onclick = async () => {
    if (!confirm(i('wt.confirmRemove'))) return;
    if (await guard(api.worktreeRemove(state.project, task.id))) await reloadWorktree();
  };
  if (wt.ahead === 0 && wt.dirty.length === 0) box.append(el('span', { class: 'muted' }, i('wt.clean')));
  box.append(diffBtn, mergeBtn, rmBtn, pre);
}

// ---- 事件綁定 ----

$('task-archive').onclick = async () => {
  if (!state.task || !confirm(i('app.confirmArchiveTask'))) return;
  if (await guard(api.archiveTask(state.project, state.task.id))) location.reload();
};

$('project-create').onclick = async () => {
  const input = $<HTMLInputElement>('project-name');
  const name = input.value.trim();
  if (!name) return;
  if (await guard(api.createProject(name))) {
    input.value = '';
    await reloadBootstrap();
    await selectProject(name);
  }
};

$('task-create').onclick = async () => {
  const input = $<HTMLInputElement>('task-title');
  const title = input.value.trim();
  if (!title || !state.project) return;
  const task = await guard(api.createTask(state.project, title, $<HTMLSelectElement>('task-role').value));
  if (task) {
    input.value = '';
    await reloadTasks();
    await selectTask(task);
  }
};

async function patchTask(patch: TaskPatch): Promise<void> {
  if (!state.task) return;
  const task = await guard(api.updateTask(state.project, state.task.id, patch));
  if (task) applyTask(state.project, task);
  else renderTaskHeader(); // 失敗就把下拉值改回去
}

$<HTMLSelectElement>('task-state').onchange = (e) => void patchTask({ state: (e.target as HTMLSelectElement).value as TaskState });
$<HTMLSelectElement>('task-role-edit').onchange = (e) => void patchTask({ role: (e.target as HTMLSelectElement).value });
$<HTMLSelectElement>('task-cli-edit').onchange = (e) => void patchTask({ cli: (e.target as HTMLSelectElement).value, model: '' });
$<HTMLSelectElement>('task-model-edit').onchange = (e) => void patchTask({ model: (e.target as HTMLSelectElement).value });
$<HTMLSelectElement>('task-effort-edit').onchange = (e) => void patchTask({ effort: (e.target as HTMLSelectElement).value });
$('task-complete').onclick = () => {
  if (confirm(i('app.confirmCompleteQuestion'))) void patchTask({ state: '完成', question: '' });
};

$<HTMLSelectElement>('composer-cli').onchange = renderModelOptions;

async function sendComposer(): Promise<boolean> {
  if (!state.task) return false;
  const ta = $<HTMLTextAreaElement>('composer-text');
  const text = ta.value.trim();
  if (!text) return false;
  const limit = state.boot?.limits.promptChars ?? 10_000;
  if (text.length > limit) {
    toast(i('app.promptTooLong', { limit }));
    return false;
  }
  const cli = $<HTMLSelectElement>('composer-cli').value;
  const model = $<HTMLSelectElement>('composer-model').value;
  const effort = $<HTMLSelectElement>('composer-effort').value;
  const r = await guard(api.send(state.project, state.task.id, text, { ...(cli ? { cli } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }));
  if (!r) return false; // 草稿保留可重試
  ta.value = '';
  if (r.queued) toast(i('app.queued'));
  return true;
}

$<HTMLFormElement>('composer').onsubmit = (e) => {
  e.preventDefault();
  void sendComposer();
};

$<HTMLTextAreaElement>('composer-text').onkeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $<HTMLFormElement>('composer').requestSubmit();
};

function stopCurrent(): void {
  if (!state.task || !state.running) return;
  state.stopping = true;
  renderLog();
  void guard(api.stop(state.project, state.task.id));
}

$('composer-stop').onclick = stopCurrent;

/** 取消並重送：把草稿排在最前面（其餘排隊照舊），再停止目前這輪。 */
$('composer-cancel-resend').onclick = async () => {
  if (!state.task || !state.running) return;
  if (!$<HTMLTextAreaElement>('composer-text').value.trim()) {
    toast(i('app.cancelResendNeedsText'));
    return;
  }
  if (!(await sendComposer())) return;
  const mine = state.queue.at(-1);
  if (mine && state.queue.length > 1) await guard(api.queueMoveFirst(state.project, state.task.id, mine.request));
  stopCurrent();
};

// ---- 語言 ----

function renderAll(): void {
  applyStatic();
  renderProjects();
  renderTasks();
  if (state.task) {
    renderTaskHeader();
    renderComposerOptions();
    renderLog(true);
    renderQueue();
    renderWorktree();
  }
  if (state.project) $('tasks-title').textContent = i('app.tasksOf', { name: state.project });
}

const langSelect = $<HTMLSelectElement>('language');
fillSelect(
  langSelect,
  LOCALES.map((l) => ({ value: l, label: localeName(l) })),
  false,
);
langSelect.value = getLocale();
langSelect.onchange = () => {
  setLocale(langSelect.value as Locale);
  renderAll();
};

applyStatic();
openGlobalStream();
void reloadBootstrap();
