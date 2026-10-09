// YuMeewADE 前端：三欄（專案／作業／對話）。vanilla TypeScript，狀態集中在 state 物件，畫面以函式重繪。

import type { Bootstrap, ChatRow, ProjectStatus, QueueItem, RunState, Task, TaskState, WorktreeStatus } from '../shared/types.ts';
import { TASK_STATES } from '../shared/types.ts';
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
  partial: '',
  queue: [] as QueueItem[],
  worktree: null as WorktreeStatus | null,
  stream: null as EventSource | null,
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
      const generic = i(`err.${err.code}` as MessageKey);
      // 伺服器的補充說明是繁中；非預設訊息時附在後面
      const detail = err.message && err.message !== generic ? `（${err.message}）` : '';
      toast(`${err.status}：${generic}${detail}`);
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

function fillSelect(select: HTMLSelectElement, options: Array<{ value: string; label: string; disabled?: boolean }>, keep = true): void {
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
      sub.append(el('span', { class: `badge ${p.status}` }, i(`state.${p.status as ProjectStatus}` as MessageKey)), el('span', {}, p.updated));
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
  if (state.task) state.task = tasks.find((t) => t.id === state.task?.id) ?? null;
  renderTasks();
}

function renderTasks(): void {
  const ul = $('task-list');
  ul.replaceChildren(
    ...state.tasks.map((t) => {
      const li = el('li', { class: t.id === state.task?.id ? 'active' : '' });
      li.append(el('div', {}, t.title || '(無標題)'));
      const sub = el('div', { class: 'sub' });
      sub.append(el('span', { class: `badge ${t.state}` }, t.state), el('span', {}, t.id));
      if (t.steps.total) sub.append(el('span', {}, `${t.steps.done}/${t.steps.total}`));
      if (t.question) sub.append(el('span', { class: 'badge 等待回覆' }, '輪到你了'));
      li.append(sub);
      li.onclick = () => void selectTask(t);
      return li;
    }),
  );
}

// ---- 對話欄 ----

async function selectTask(t: Task): Promise<void> {
  state.task = t;
  state.log = [];
  state.partial = '';
  state.running = null;
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
    renderLog();
  }
}

function renderTaskHeader(): void {
  const t = state.task;
  if (!t) return;
  $('chat-title').textContent = `${t.id}　${t.title}`;
  const sel = $<HTMLSelectElement>('task-state');
  fillSelect(sel, TASK_STATES.map((s) => ({ value: s, label: i(`state.${s}` as MessageKey) })), false);
  sel.value = t.state;
  $('task-steps').textContent = t.steps.total ? i('app.steps', { done: t.steps.done, total: t.steps.total }) : '';
  $('task-meta').textContent = [t.role && i('app.metaRole', { role: t.role }), t.owner && i('app.metaOwner', { owner: t.owner }), t.phase && i('app.metaPhase', { phase: t.phase }), i('app.metaUpdated', { updated: t.updated })]
    .filter(Boolean)
    .join('　');
  const q = $('task-question');
  q.textContent = t.question ? i('app.yourTurnQuestion', { question: t.question }) : '';
  q.classList.toggle('hidden', !t.question);
}

function renderComposerOptions(): void {
  const boot = state.boot;
  if (!boot) return;
  const t = state.task;
  const role = t?.role ? boot.roles.roles[t.role] : undefined;
  const defaultCli = t?.cli || role?.main.cli || '';
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
  const boot = state.boot;
  if (!boot) return;
  const cli = $<HTMLSelectElement>('composer-cli').value;
  const models = cli ? (boot.roles.models[cli] ?? []) : [];
  fillSelect($('composer-model'), [{ value: '', label: i('app.modelDefault') }, ...models.filter((m) => m !== 'default').map((m) => ({ value: m, label: m }))]);
}

function rowNode(r: ChatRow): HTMLElement {
  const node = el('div', { class: `msg ${r.role}` });
  const who = r.role === 'user' ? i('app.you') : r.role === 'assistant' ? `${i('app.ai', { cli: r.cli })}${r.model ? ` · ${r.model}` : ''}` : i('app.error');
  const flag = r.cancelled ? i('app.cancelled') : r.interrupted ? i('app.interrupted') : '';
  node.append(el('div', { class: 'meta' }, `${who} ${flag} ${new Date(r.at).toLocaleString()}`), document.createTextNode(r.text));
  return node;
}

function renderLog(): void {
  const box = $('chat-log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren(...state.log.map(rowNode));
  if (state.running) {
    const p = el('div', { class: 'msg assistant partial' });
    p.append(el('div', { class: 'meta' }, i('app.running', { cli: state.running.cli })), document.createTextNode(state.partial));
    box.append(p);
  }
  if (atBottom || state.running) box.scrollTop = box.scrollHeight;
  $<HTMLButtonElement>('composer-stop').disabled = !state.running;
  $('status').textContent = state.running ? i('app.runningStatus', { cli: state.running.cli }) : '';
}

function renderQueue(): void {
  const box = $('queue');
  box.classList.toggle('hidden', state.queue.length === 0);
  box.replaceChildren(
    el('div', { class: 'muted' }, `排隊中的指示（${state.queue.length}）`),
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

function openStream(): void {
  state.stream?.close();
  if (!state.task) return;
  const task = state.task.id;
  const es = new EventSource(api.streamUrl(state.project, task));
  state.stream = es;
  const parse = <T>(e: MessageEvent): T => JSON.parse(e.data as string) as T;
  es.addEventListener('ready', (e) => {
    const d = parse<{ running: RunState | null; partial: string; queue: QueueItem[]; task: Task | null }>(e);
    state.running = d.running;
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
    const row = parse<ChatRow>(e);
    state.log.push(row);
    // user 列代表一輪開始（含出隊執行）；其他列代表本輪輸出已落檔
    if (row.role === 'user') state.running = { request: row.request, cli: row.cli, ...(row.model ? { model: row.model } : {}), startedAt: row.at };
    else state.partial = '';
    renderLog();
  });
  es.addEventListener('delta', (e) => {
    const d = parse<{ request: string; text: string }>(e);
    if (!state.running) state.running = { request: d.request, cli: '?', startedAt: '' };
    state.partial += d.text;
    renderLog();
  });
  es.addEventListener('done', () => {
    state.running = null;
    state.partial = '';
    renderLog();
    void reloadTasks();
    void reloadWorktree();
  });
  es.addEventListener('error', (e) => {
    if ((e as MessageEvent).data) toast(i('app.cliFailed'));
    else $('status').textContent = i('app.disconnected');
  });
  es.addEventListener('queue', (e) => {
    state.queue = parse<QueueItem[]>(e);
    renderQueue();
  });
  es.addEventListener('task', (e) => {
    state.task = parse<Task>(e);
    renderTaskHeader();
    void reloadTasks();
  });
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
  const t = state.task;
  if (!wt || !t) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren();
  if (!wt.exists) {
    const btn = el('button', { type: 'button' }, i('wt.create'));
    btn.onclick = async () => {
      if (await guard(api.worktreeCreate(state.project, t.id))) await reloadWorktree();
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
    const d = await guard(api.worktreeDiff(state.project, t.id));
    if (!d) return;
    pre.textContent = (d.diff || i('wt.noDiff')) + (d.truncated ? '\n' + i('wt.truncated') : '');
    pre.classList.remove('hidden');
  };
  mergeBtn.onclick = async () => {
    if (!confirm(i('wt.confirmMerge', { branch: wt.branch }))) return;
    const r = await guard(api.worktreeMerge(state.project, t.id));
    if (!r) return;
    toast(r.merged ? i('wt.merged', { commit: r.commit ?? '' }) : i('wt.conflict', { files: (r.conflicts ?? []).join(', ') }));
    await reloadWorktree();
  };
  rmBtn.onclick = async () => {
    if (!confirm(i('wt.confirmRemove'))) return;
    if (await guard(api.worktreeRemove(state.project, t.id))) await reloadWorktree();
  };
  box.append(diffBtn, mergeBtn, rmBtn, pre);
}

// ---- 事件綁定 ----

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
  const t = await guard(api.createTask(state.project, title, $<HTMLSelectElement>('task-role').value));
  if (t) {
    input.value = '';
    await reloadTasks();
    await selectTask(t);
  }
};

$<HTMLSelectElement>('task-state').onchange = async (e) => {
  if (!state.task) return;
  const value = (e.target as HTMLSelectElement).value as TaskState;
  const t = await guard(api.updateTask(state.project, state.task.id, { state: value }));
  if (t) {
    state.task = t;
    renderTaskHeader();
    await reloadTasks();
  }
};

$<HTMLSelectElement>('composer-cli').onchange = renderModelOptions;

$<HTMLFormElement>('composer').onsubmit = async (e) => {
  e.preventDefault();
  if (!state.task) return;
  const ta = $<HTMLTextAreaElement>('composer-text');
  const text = ta.value.trim();
  if (!text) return;
  const limit = state.boot?.limits.promptChars ?? 10_000;
  if (text.length > limit) {
    toast(`指示超過 ${limit} 字`);
    return;
  }
  const cli = $<HTMLSelectElement>('composer-cli').value;
  const model = $<HTMLSelectElement>('composer-model').value;
  const effort = $<HTMLSelectElement>('composer-effort').value;
  const r = await guard(api.send(state.project, state.task.id, text, { ...(cli ? { cli } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }));
  if (!r) return; // 草稿保留可重試
  ta.value = '';
  if (r.queued) toast('已排隊，本輪結束後執行');
};

$<HTMLTextAreaElement>('composer-text').onkeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $<HTMLFormElement>('composer').requestSubmit();
};

$('composer-stop').onclick = () => {
  if (state.task) void guard(api.stop(state.project, state.task.id));
};

// ---- 語言 ----

function renderAll(): void {
  applyStatic();
  renderProjects();
  renderTasks();
  if (state.task) {
    renderTaskHeader();
    renderComposerOptions();
    renderLog();
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
void reloadBootstrap();
