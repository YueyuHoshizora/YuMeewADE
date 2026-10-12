import { type AppState, type ArchiveEntry, type NewTaskInput, type ProjectView, type SlashCommand, type StartInput, type Task } from '../../shared/types.ts';
import { ApiFailure, api, query, request } from '../api.ts';
import { labelValue, t } from '../i18n/index.ts';
import { attachments } from '../components/attachments.ts';
import { aiPicker } from '../components/picker.ts';
import { markdown } from '../components/markdown.ts';
import { archiveFlow, area, button, card, checksModal, confirmModal, disclosure, el, field, input, lines, link, projectHash, readLocal, row, run, select, storeLocal, taskHash, textModal, toast, UserError, workspaceLocalKey, type View, type ViewContext } from '../components/dom.ts';
import { localDateTime, localTime } from '../components/display.ts';
import { shouldSend } from '../components/composer.ts';
import { attachSlashCommands } from '../components/slash-menu.ts';
import { verificationConfigButton } from '../components/verification-config.ts';
import { archiveButton } from '../components/archive.ts';
import { gitWorkbenchButton } from '../components/git-workbench.ts';
import { projectTrustButton } from '../components/project-trust.ts';
import { confirmUsageRound } from '../components/usage-history.ts';
import { attachComposeInsert } from '../components/mention.ts';
import { onboardingBanner } from '../components/onboarding.ts';
import { githubIssuesButton } from '../components/github-issues.ts';
import { metadataBadge, metadataFields } from '../components/task-metadata.ts';
import { taskTemplates } from '../components/task-templates.ts';
import { memoryPanel } from '../components/memory.ts';
import { activityDots, taskBoard } from '../components/task-board.ts';
import { phaseEditor } from '../components/phase-editor.ts';
import { PHASES_MAX, TASK_STATES, type BulkTaskAction, type BulkTaskResult } from '../../shared/types.ts';
import type { MessageKey } from '../i18n/zh-TW.ts';

async function startWithBudget(context: ViewContext, input: StartInput): Promise<void> {
  // The server only rejects an empty AI as a missing field; say why nothing can start instead.
  if (!input.ai) throw new UserError(t('onboarding.banner'));
  const { task } = await request<{ task: Task }>('/api/start/prepare', input);
  const draftKey = workspaceLocalKey(context.state, 'draft', `${input.project}/${task.id}`);
  storeLocal(draftKey, input.text);
  storeLocal(workspaceLocalKey(context.state, 'quick', input.project), '');
  try {
    if (!await confirmUsageRound({ project: input.project, task: task.id, ai: input.ai, account: context.state.settings.activeAccounts[input.ai] ?? 'default' })) return;
    await api.send({ ...input, task: task.id });
    storeLocal(draftKey, '');
  } finally {
    await context.refresh(); location.hash = taskHash(input.project, task.id);
  }
}

declare global { interface Window { yumeewade?: { desktop: true; platform: string; pickFolder: () => Promise<string | null>; setBadge: (count: number) => void; focus: () => void; onMenuCommand?: (callback: (command: string) => void) => () => void }; } }

const normalizePath = (value: string): string => { const slashed = value.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[A-Za-z]:/.test(slashed) || slashed.startsWith('//') ? slashed.toLowerCase() : slashed; };

/** 以系統資料夾選擇器開啟專案：符合台帳資料夾或主資料夾就直接開啟；屬於已封存專案就提示還原；否則確認後以該資料夾為主資料夾建立專案。網頁版沒有選擇器，改進清單頁。 */
export async function openProjectFromFolder(context: ViewContext): Promise<void> {
  const pick = window.yumeewade?.pickFolder;
  if (!pick) { location.hash = '#/open'; return; }
  const value = await pick();
  if (!value) return;
  const target = normalizePath(value);
  const found = context.state.projects.find(project => normalizePath(project.dir) === target) ?? context.state.projects.find(project => normalizePath(project.bodyPath) === target);
  if (found) { location.hash = projectHash(found.id); return; }
  const name = value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '';
  const sameKey = (key: string) => key.toLocaleLowerCase() === name.toLocaleLowerCase();
  const archived = await request<ArchiveEntry[]>('/api/archive/list');
  // 主資料夾相同的封存專案優先於同名的進行中專案：使用者選的是那份程式碼。
  const archivedBody = archived.find(entry => entry.body && normalizePath(entry.body) === target);
  if (archivedBody && await offerRestore(context, archivedBody)) return;
  // 資料夾名稱與既有專案同名（含大小寫差異）時，建立必定失敗，直接開啟該專案。
  const sameName = context.state.projects.find(project => [project.id, project.name].some(sameKey));
  if (sameName) { location.hash = projectHash(sameName.id); return; }
  // 同名的封存專案：另建新專案會讓它之後無法還原，所以先提議還原；拒絕才改為建立。
  const archivedName = archived.find(entry => [entry.project, entry.name].some(sameKey));
  if (archivedName && archivedName !== archivedBody && await offerRestore(context, archivedName)) return;
  if (!await confirmModal(t('project.adoptTitle'), t('project.adoptMessage', { name }), t('project.adoptAccept'))) return;
  // Failures (e.g. a folder name that is not a valid project name) reach the caller's run(), which shows the translated detail.
  const project = await api.createProject({ name, description: '', phases: lines(t('project.defaultPhases')), body: value, parent: '', related: [] });
  await context.refresh(); location.hash = projectHash(project.id);
}

/** 確認後還原封存專案並開啟；回傳是否已還原。 */
async function offerRestore(context: ViewContext, entry: ArchiveEntry): Promise<boolean> {
  if (!await confirmModal(t('project.restoreTitle'), t('project.restoreMessage', { name: entry.name, at: localDateTime(new Date(entry.archivedAt).toISOString()) }), t('project.restoreAccept'))) return false;
  const restored = await request<ArchiveEntry>('/api/archive/restore', { key: entry.key });
  await context.refresh(); location.hash = projectHash(restored.project);
  return true;
}

export function openProjectView(context: ViewContext): View {
  const node = el('div', 'page'); const search = input('', t('project.searchExisting'));
  search.type = 'search'; search.setAttribute('aria-label', t('project.searchExisting'));
  const projects = el('div', 'task-list');
  function render(): void {
    const term = search.value.trim().toLocaleLowerCase();
    const matches = context.state.projects.filter(project => [project.name, project.id, project.bodyPath].some(value => value.toLocaleLowerCase().includes(term)));
    projects.replaceChildren(...matches.map(project => card(project.name,
      el('p', 'muted', project.bodyPath),
      row(el('span', 'state-chip', t(`state.${project.status}`)), link(t('project.openNamed', { name: project.name }), projectHash(project.id), 'primary')),
    )));
    if (!matches.length) projects.append(el('p', 'muted', t('project.noExisting')), link(t('nav.settings'), '#/settings'));
  }
  search.oninput = render; render();
  node.append(el('h1', '', t('project.openExisting')), el('p', 'muted', t('project.existingHint')), ...(window.yumeewade?.pickFolder ? [button(t('project.pickFolder'), () => openProjectFromFolder(context), 'primary')] : []), search, projects, link(t('project.new'), '#/new'));
  return { node, update: state => { context.state = state; render(); } };
}

export function newProjectView(context: ViewContext, params: URLSearchParams): View {
  const node = el('div', 'page'); const name = input(); name.required = true; name.maxLength = 60;
  node.append(onboardingBanner(context));
  const first = area(); first.maxLength = context.state.limits.promptChars; const description = area(); description.maxLength = 400;
  const phases = area(t('project.defaultPhases')); const body = input(); const related: string[] = [];
  const parent = select([{ value: '', label: t('common.none') }, ...context.state.projects.map(p => ({ value: p.id, label: p.name }))], params.get('parent') ?? '');
  const folder = row(body); folder.classList.add('folder-field');
  if (window.yumeewade?.pickFolder) folder.append(button(t('project.pickFolder'), async () => { const value = await window.yumeewade!.pickFolder(); if (value) body.value = value; }));
  const relations = el('div', 'check-grid'); for (const p of context.state.projects) { const check = input(); check.type = 'checkbox'; check.onchange = () => { const at = related.indexOf(p.id); if (check.checked && at < 0) related.push(p.id); else if (!check.checked && at >= 0) related.splice(at, 1); }; relations.append(field(p.name, check)); }
  const details = disclosure(t('common.details'), field(t('project.body'), folder), field(t('project.parent'), parent), field(t('project.related'), relations)); details.open = !!params.get('parent');
  const form = el('form', 'form'); const submit = el('button', 'primary', t('project.create')); submit.type = 'submit';
  const existing = el('div'); existing.setAttribute('aria-live', 'polite');
  function showExisting(): boolean {
    const value = name.value.trim().toLowerCase();
    const project = value ? context.state.projects.find(project => project.id.toLowerCase() === value || project.name.toLowerCase() === value) : undefined;
    existing.replaceChildren();
    if (!project) return false;
    existing.append(el('p', '', t('detail.project_exists')), el('p', 'muted', t('project.existsHint')), link(t('project.openNamed', { name: project.name }), projectHash(project.id), 'primary'));
    return true;
  }
  name.oninput = () => { showExisting(); };
  form.append(field(t('project.name'), name), existing, field(t('project.firstTask'), first), field(t('project.description'), description), field(t('project.phases'), phases), details, submit);
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    submit.disabled = true;
    try {
      if (lines(phases.value).length > PHASES_MAX) throw new UserError(t('phases.tooMany', { n: PHASES_MAX }));
      const project = await api.createProject({ name: name.value.trim(), description: description.value.trim(), phases: lines(phases.value), body: body.value.trim(), parent: parent.value, related });
      // 建立台帳成功後立即離開此表單；即使第一輪失敗，也不能重複建立專案。
      await context.refresh(); location.hash = projectHash(project.id);
      if (first.value.trim()) await startWithBudget(context, { project: project.id, text: first.value.trim(), ...context.state.settings.initial });
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.body.detail !== 'project_exists') throw error;
      await context.refresh();
      if (!showExisting()) throw error;
    } finally { submit.disabled = false; }
  }); };
  node.append(row(el('h1', '', t('project.new')), button(t('project.openExisting'), () => openProjectFromFolder(context))), form);
  return { node, update: state => { context.state = state; showExisting(); } };
}

export function detailedTaskForm(context: ViewContext, project: ProjectView, params: URLSearchParams): HTMLElement {
  const title = input(); title.required = true; title.maxLength = 80;
  const role = select([{ value: '', label: t('common.none') }, ...Object.keys(context.state.roles.roles).map(name => ({ value: name, label: name }))]);
  const options = [{ value: '', label: t('common.none') }, ...project.tasks.map(task => ({ value: task.id, label: task.title }))];
  const phase = select([{ value: '', label: t('common.none') }, ...project.phases.map(p => ({ value: p.name, label: p.name }))], project.currentPhase);
  const parent = select(options, params.get('parent') ?? ''); const source = select(options, params.get('derived') ?? '');
  const kind = select([{ value: 'main', label: t('task.main') }, { value: 'derived', label: t('task.derived') }], params.has('derived') ? 'derived' : 'main');
  const workspace = select([{ value: 'isolated', label: t('task.isolated') }, { value: 'direct', label: t('task.direct') }], 'isolated'); const steps = area();
  const metadata = metadataFields();
  const form = el('form', 'form'); const submit = el('button', 'primary', t('task.create')); submit.type = 'submit';
  const grid = el('div', 'form-grid'); grid.append(field(t('task.role'), role), field(t('task.phase'), phase), field(t('task.parent'), parent), field(t('task.kind'), kind), field(t('task.source'), source), field(t('task.workspace'), workspace));
  form.append(field(t('common.title'), title), grid, metadata.node, field(t('task.stepsInput'), steps), submit);
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    submit.disabled = true;
    try {
      const input: NewTaskInput = {
        title: title.value.trim(), role: role.value, phase: phase.value, parent: parent.value,
        kind: kind.value === 'derived' ? 'derived' : 'main',
        derivedFrom: kind.value === 'derived' ? source.value : '',
        workspace: workspace.value === 'direct' ? 'direct' : 'isolated',
        steps: lines(steps.value),
        ...metadata.value(),
      };
      const task = await api.createTask(project.id, input); await context.refresh(); location.hash = taskHash(project.id, task.id);
    } finally { submit.disabled = false; }
  }); };
  const detail = disclosure(t('project.detailedTask'), form); detail.id = 'add-task'; detail.open = params.has('parent') || params.has('derived'); return detail;
}

export function projectView(context: ViewContext, project: ProjectView, params: URLSearchParams): View {
  const node = el('div', 'page project-page'); const overview = el('div', 'project-overview');
  // Only this project's running/unread tasks and the related projects' names affect the page; activity elsewhere must not redraw it.
  const activityOf = (state: AppState, related: string[]) => JSON.stringify([
    state.running.filter(item => item.project === project.id).map(item => item.task),
    state.unread.filter(item => item.project === project.id).map(item => item.task),
    related.map(id => state.projects.find(other => other.id === id)?.name ?? null),
  ]);
  let activity = activityOf(context.state, project.related);
  let selecting = false, bulkBusy = false;
  // The chosen bulk action and its value survive redraws triggered by unrelated activity.
  let bulkKind = 'state', bulkValue = '';
  const selected = new Set<string>();
  const bulkResults = el('div'); bulkResults.setAttribute('aria-live', 'polite');
  const count = el('span');
  function updateCount(): void { count.textContent = t('bulk.count', { count: selected.size }); }
  function bulkToolbar(): HTMLElement {
    const mode = button(t(selecting ? 'bulk.cancel' : 'bulk.select'), () => { selecting = !selecting; selected.clear(); renderOverview(); });
    mode.disabled = bulkBusy;
    if (!selecting) return row(mode, bulkResults);
    const kind = select(['state', 'phase', 'addTag', 'removeTag', 'due', 'archive'].map(value => ({ value, label: t(`bulk.${value}` as MessageKey) })), bulkKind);
    const value = el('div');
    let readValue: () => string = () => '';
    function changeAction(): void {
      const control = kind.value === 'state' ? select(TASK_STATES.map(state => ({ value: state, label: t(`state.${state}`) })))
        : kind.value === 'phase' ? select([{ value: '', label: t('common.none') }, ...project.phases.map(phase => ({ value: phase.name, label: phase.name }))])
        : input();
      if (control instanceof HTMLInputElement) { control.type = kind.value === 'due' ? 'date' : 'text'; control.maxLength = 60; }
      control.setAttribute('aria-label', t(`bulk.${kind.value}` as MessageKey));
      // A select ignores a value it has no option for, so a stale draft falls back to its first option.
      if (bulkValue) control.value = bulkValue;
      bulkValue = control.value;
      control.oninput = control.onchange = () => { bulkValue = control.value; };
      readValue = () => control.value;
      value.replaceChildren(...(kind.value === 'archive' ? [] : [control]));
    }
    kind.onchange = () => { bulkKind = kind.value; bulkValue = ''; changeAction(); }; changeAction(); updateCount();
    const apply = button(t('bulk.apply'), async () => {
      if (bulkBusy || !selected.size) return;
      bulkBusy = true; mode.disabled = true; kind.disabled = true;
      const ids = [...selected]; bulkResults.replaceChildren();
      try {
        let results: BulkTaskResult[];
        if (kind.value === 'archive') {
          results = [];
          for (const task of ids) {
            try {
              const title = project.tasks.find(item => item.id === task)?.title ?? task;
              if (await archiveFlow('/api/task/archive', { project: project.id, task }, title, 'archive_has_worktree')) results.push({ task, ok: true });
            } catch (error) {
              if (!(error instanceof ApiFailure)) throw error;
              results.push({ task, ok: false, error: error.body.error, ...(error.body.detail ? { detail: error.body.detail } : {}) });
            }
          }
        } else {
          const action = { kind: kind.value, value: readValue() } as BulkTaskAction;
          results = (await request<{ results: BulkTaskResult[] }>('/api/task/bulk', { project: project.id, tasks: ids, action })).results;
        }
        for (const result of results) {
          if (result.ok) selected.delete(result.task);
          else bulkResults.append(el('p', 'error', `${project.tasks.find(task => task.id === result.task)?.title ?? result.task}: ${t((result.detail ? `detail.${result.detail}` : `err.${result.error}`) as MessageKey, { field: kind.value })}`));
        }
        bulkResults.prepend(el('p', '', t('bulk.result', { ok: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length })));
        await context.refresh();
      } finally { bulkBusy = false; renderOverview(); }
    });
    apply.disabled = bulkBusy;
    return row(mode, count, kind, value, apply, bulkResults);
  }
  function tasksList(tasks: typeof project.tasks): HTMLElement {
    const list = el('div', 'task-list');
    if (selecting && tasks.length) list.append(button(t('bulk.all'), () => {
      if (bulkBusy) return;
      if (tasks.every(task => selected.has(task.id))) for (const task of tasks) selected.delete(task.id);
      else for (const task of tasks) { if (selected.size >= 200) break; selected.add(task.id); }
      renderOverview();
    }));
    for (const task of tasks) {
      const heading = el('span', 'task-list-title'); heading.append(link(task.title, taskHash(project.id, task.id)), ...activityDots(context, project.id, task.id));
      const item = row(heading, el('span', 'state-chip', t(`state.${task.state}`)), metadataBadge(task), ...(task.confirm ? [el('span', 'warning', t('board.approval'))] : []));
      if (selecting) {
        const check = input(); check.type = 'checkbox'; check.checked = selected.has(task.id); check.disabled = bulkBusy;
        check.setAttribute('aria-label', t('bulk.task', { title: task.title }));
        check.onchange = () => { if (check.checked && selected.size < 200) selected.add(task.id); else { selected.delete(task.id); check.checked = false; } updateCount(); };
        item.prepend(check);
      }
      list.append(item);
    }
    if (!tasks.length) list.append(el('p', 'muted', t('common.empty')));
    return list;
  }
  // Panels holding user edits are built once and re-appended: renderOverview runs on every running/unread change anywhere in the workspace.
  const rules = area('', t('project.rulesPlaceholder'));
  rules.rows = 12;
  rules.maxLength = 20000;
  rules.disabled = true;
  const rulesBox = disclosure(t('project.rules'), el('p', 'muted', t('project.rulesHint')), rules, button(t('common.save'), async () => {
    await request('/api/project/rules', { project: project.id, text: rules.value });
    toast(t('common.saved'));
  }));
  let rulesLoading = false;
  rulesBox.addEventListener('toggle', () => {
    if (!rulesBox.open || rulesLoading || !rules.disabled) return;
    rulesLoading = true;
    void run(async () => {
      try {
        rules.value = (await request<{ text: string }>(query('/api/project/rules', { project: project.id }))).text;
        rules.disabled = false;
      } finally { rulesLoading = false; }
    });
  });
  const memory = memoryPanel(project.id);
  // Task templates list the project's tasks as sources, so they are rebuilt only when that list changes.
  let templates: { key: string; node: HTMLElement } | undefined;
  function renderOverview(): void {
    const opened = new Set(Array.from(overview.querySelectorAll('details[open]')).map(d => d.querySelector('summary')?.textContent));
    const focused = overview.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    overview.replaceChildren();
    const header = el('header', 'page-header');
    header.append(el('h1', '', project.name), el('span', 'state-chip', t(`state.${project.status}`)), el('span', 'muted', t('common.updated', { at: localTime(project.updated) })));
    if (project.related.length) {
      // Related projects are stored at creation; list them so the choice is visible. Archived or missing ids stay plain text.
      const related = el('p', 'muted related-projects', labelValue(t('project.related'), ''));
      for (const [index, id] of project.related.entries()) {
        const target = context.state.projects.find(other => other.id === id);
        related.append(...(index ? [document.createTextNode(t('common.listSeparator'))] : []), target ? link(target.name, projectHash(target.id)) : document.createTextNode(id));
      }
      header.append(related);
    }
    const actions = row(
      button(t('common.open'), () => request('/api/open', { path: project.bodyPath })),
      button(t(project.status === '完成' ? 'project.reopen' : 'project.complete'), async () => {
        await request('/api/project/update', { project: project.id, patch: { status: project.status === '完成' ? '進行中' : '完成' } }); await context.refresh();
      }),
      button(t('common.archive'), async () => {
        if (await archiveFlow('/api/project/archive', { project: project.id }, project.name, 'archive_project_has_worktrees')) { await context.refresh(); location.hash = '#/turn'; }
      }, 'danger'),
      archiveButton(context, project.id),
      gitWorkbenchButton(context, project.id),
      githubIssuesButton(context, project.id),
      verificationConfigButton(context, project.id),
      projectTrustButton(project.id),
    );
    const editDescription = button(t('project.editDescription'), async () => {
      const description = await textModal(t('project.editDescription'), project.description, 400);
      if (description === null || description === project.description) return;
      await request('/api/project/update', { project: project.id, patch: { description } }); await context.refresh();
    });
    const editRelated = button(t('project.editRelated'), async () => {
      const options = context.state.projects.filter(other => other.id !== project.id).map(other => ({ value: other.id, label: other.name }));
      const related = await checksModal(t('project.editRelated'), options, project.related);
      // Ids of archived projects are not offered, so a save drops them, the same as unchecking.
      if (related === null || JSON.stringify(related) === JSON.stringify(project.related)) return;
      await request('/api/project/update', { project: project.id, patch: { related } }); await context.refresh();
    });
    // Pointing the project at a moved main folder; the desktop app offers its folder picker instead of a typed path.
    const editBody = () => button(t('project.editBody'), async () => {
      const body = window.yumeewade?.pickFolder ? await window.yumeewade.pickFolder() : await textModal(`${t('project.editBody')} — ${t('project.bodyHint')}`, project.body || project.bodyPath, 4096, 2);
      if (!body || body.trim() === project.body) return;
      await request('/api/project/update', { project: project.id, patch: { body: body.trim() } }); await context.refresh();
    });
    const editNotes = button(t('project.editNotes'), async () => {
      const original = (await request<{ text: string }>(query('/api/project/notes', { project: project.id }))).text;
      const text = await textModal(t('project.editNotes'), original, 20_000, 14);
      if (text === null || text === original.trim()) return;
      await request('/api/project/notes', { project: project.id, text, previous: original }); await context.refresh();
    });
    if (project.bodyMissing) overview.append(header, el('p', 'warning', t('project.bodyMissing', { path: project.bodyPath })), row(editBody()));
    else overview.append(header);
    overview.append(actions, disclosure(t('project.notes'), markdown(project.description + '\n\n' + project.notes), row(editDescription, editNotes, editRelated, editBody())));
    if (project.issues.length) {
      const localIssues = el('div', 'form');
      for (const issue of project.issues) localIssues.append(el('p', '', `${issue.level ? `[${issue.level}] ` : ''}${issue.text}`));
      overview.append(disclosure(t('github.localIssues'), localIssues));
    }
    overview.append(rulesBox);
    const templatesKey = JSON.stringify(project.tasks.map(task => [task.id, task.title]));
    if (templates?.key !== templatesKey) templates = { key: templatesKey, node: taskTemplates(context, project) };
    overview.append(templates.node);
    overview.append(memory);
    if (project.phases.length) {
      const road = el('div', 'phase-road');
      for (const [i, phase] of project.phases.entries()) road.append(el('div', `phase ${phase.name === project.currentPhase ? 'current' : ''} ${phase.state === '完成' ? 'complete' : ''}`, `${i + 1} · ${phase.name}`));
      overview.append(road);
    }
    overview.append(phaseEditor(project, context.refresh));
    if (project.phaseOffer) overview.append(card(t('project.phaseComplete'), row(
      button(t('project.nextPhase'), async () => { await request('/api/phase/next', { project: project.id, phase: project.currentPhase }); await context.refresh(); }, 'primary'),
      button(t('project.continuePhase'), async () => { await request('/api/phase/continue', { project: project.id, phase: project.currentPhase }); await context.refresh(); }),
    )));
    for (const id of selected) if (!project.tasks.some(task => task.id === id)) selected.delete(id);
    overview.append(bulkToolbar());
    overview.append(taskBoard(context, project, tasks => {
      const sections = el('div');
      const active = tasks.filter(task => task.state !== '完成');
      // A task without a phase belongs to no other phase, so it stays in the main list instead of a collapsed "none" group.
      const inCurrent = (task: (typeof tasks)[number]) => !project.currentPhase || !task.phase || task.phase === project.currentPhase;
      sections.append(card(t('project.activeTasks'), tasksList(active.filter(inCurrent))));
      const other = active.filter(task => !inCurrent(task));
      if (other.length) sections.append(disclosure(t('project.otherTasks'), ...Array.from(new Set(other.map(task => task.phase))).map(phase => disclosure(phase, tasksList(other.filter(task => task.phase === phase))))));
      sections.append(disclosure(t('project.completedTasks'), tasksList(tasks.filter(task => task.state === '完成'))));
      return sections;
    }));
    for (const detail of overview.querySelectorAll('details')) detail.open = opened.has(detail.querySelector('summary')?.textContent);
    // Rebuilt controls (bulk value, board search) are found again by their label, keeping the caret where it was.
    const label = focused?.getAttribute('aria-label');
    const target = focused?.isConnected ? focused : label ? overview.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`) : null;
    target?.focus();
    if (target !== focused && target instanceof HTMLInputElement && focused instanceof HTMLInputElement && focused.selectionStart !== null) {
      try { target.setSelectionRange(focused.selectionStart, focused.selectionEnd); } catch { /* date and other inputs have no caret */ }
    }
  }
  renderOverview(); node.append(overview);
  const draftKey = workspaceLocalKey(context.state, 'quick', project.id); const draft = area(readLocal<string>(draftKey, ''), `${t('project.quickPlaceholder')} · ${t(readLocal('yumeewade.enterToSend', false) ? 'chat.hintEnter' : 'chat.hintModifier')}`); draft.maxLength = context.state.limits.promptChars;
  draft.oninput = () => storeLocal(draftKey, draft.value);
  const disposeComposeInsert = attachComposeInsert(draft, project.id, '');
  const pick = aiPicker(context.state, project.startPick ?? context.state.settings.initial, () => slashCommands.refresh()); const upload = attachments(project.id, context.state.limits, draft);
  const slashCommands = attachSlashCommands(draft, () => JSON.stringify([
    pick.value().ai, context.state.settings.activeAccounts, context.state.settings.accounts, project.bodyPath,
  ]), async () => (await request<{ commands: SlashCommand[] }>(
    query('/api/chat/commands', { project: project.id, ai: pick.value().ai }),
  )).commands);
  const start = button(t('project.start'), async () => { await upload.ready(); if (!draft.value.trim() && !upload.ids().length) return;
    await startWithBudget(context, { project: project.id, text: draft.value.trim(), ...pick.value(), images: upload.ids() }); storeLocal(draftKey, ''); await upload.clear(); draft.value = '';
  }, 'primary');
  draft.onkeydown = e => { if (shouldSend(e, readLocal('yumeewade.enterToSend', false))) { e.preventDefault(); start.click(); } };
  node.append(card(t('project.quick'), slashCommands.node, draft, upload.node, row(pick.node, start)), detailedTaskForm(context, project, params));
  return { node, dispose: () => { slashCommands.dispose(); upload.dispose(); disposeComposeInsert(); }, update: state => {
    context.state = state;
    const next = state.projects.find(p => p.id === project.id);
    if (!next) { location.hash = '#/turn'; return; }
    const nextActivity = activityOf(state, next.related);
    if (JSON.stringify(next) !== JSON.stringify(project) || nextActivity !== activity) { project = next; activity = nextActivity; renderOverview(); }
    slashCommands.refresh();
  } };
}
