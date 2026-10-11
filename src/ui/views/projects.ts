import { type NewTaskInput, type ProjectView, type SlashCommand, type StartInput, type Task } from '../../shared/types.ts';
import { ApiFailure, api, query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { attachments } from '../components/attachments.ts';
import { aiPicker } from '../components/picker.ts';
import { markdown } from '../components/markdown.ts';
import { archiveFlow, area, button, card, confirmModal, disclosure, el, field, input, lines, link, projectHash, readLocal, row, run, select, storeLocal, taskHash, toast, type View, type ViewContext } from '../components/dom.ts';
import { localTime } from '../components/display.ts';
import { shouldSend } from '../components/composer.ts';
import { attachSlashCommands } from '../components/slash-menu.ts';
import { verificationConfigButton } from '../components/verification-config.ts';
import { archiveButton } from '../components/archive.ts';
import { gitWorkbenchButton } from '../components/git-workbench.ts';
import { projectTrustButton } from '../components/project-trust.ts';
import { confirmUsageRound } from '../components/usage-history.ts';

async function startWithBudget(context: ViewContext, input: StartInput): Promise<void> {
  const { task } = await request<{ task: Task }>('/api/start/prepare', input);
  const draftKey = `yumeewade.draft.${input.project}/${task.id}`;
  storeLocal(draftKey, input.text);
  storeLocal(`yumeewade.quick.${input.project}`, '');
  try {
    if (!await confirmUsageRound({ project: input.project, task: task.id, ai: input.ai, account: context.state.settings.activeAccounts[input.ai] ?? 'default' })) return;
    await api.send({ ...input, task: task.id });
    storeLocal(draftKey, '');
  } finally {
    await context.refresh(); location.hash = taskHash(input.project, task.id);
  }
}

declare global { interface Window { yumeewade?: { desktop: true; platform: string; pickFolder: () => Promise<string | null>; setBadge: (count: number) => void; focus: () => void }; } }

const normalizePath = (value: string): string => { const slashed = value.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[A-Za-z]:/.test(slashed) || slashed.startsWith('//') ? slashed.toLowerCase() : slashed; };

/** 以系統資料夾選擇器開啟專案：符合台帳資料夾或主資料夾就直接開啟；否則確認後以該資料夾為主資料夾建立專案。網頁版沒有選擇器，改進清單頁。 */
export async function openProjectFromFolder(context: ViewContext): Promise<void> {
  const pick = window.yumeewade?.pickFolder;
  if (!pick) { location.hash = '#/open'; return; }
  const value = await pick();
  if (!value) return;
  const target = normalizePath(value);
  const found = context.state.projects.find(project => normalizePath(project.dir) === target) ?? context.state.projects.find(project => normalizePath(project.bodyPath) === target);
  if (found) { location.hash = projectHash(found.id); return; }
  const name = value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '';
  if (!await confirmModal(t('project.adoptTitle'), t('project.adoptMessage', { name }), t('project.adoptAccept'))) return;
  try {
    const project = await api.createProject({ name, description: '', phases: lines(t('project.defaultPhases')), body: value, parent: '', related: [] });
    await context.refresh(); location.hash = projectHash(project.id);
  } catch (error) {
    if (error instanceof ApiFailure) toast(error.message); else throw error;
  }
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
    try { const project = await api.createProject({ name: name.value.trim(), description: description.value.trim(), phases: lines(phases.value), body: body.value.trim(), parent: parent.value, related });
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
  const form = el('form', 'form'); const submit = el('button', 'primary', t('task.create')); submit.type = 'submit';
  const grid = el('div', 'form-grid'); grid.append(field(t('task.role'), role), field(t('task.phase'), phase), field(t('task.parent'), parent), field(t('task.kind'), kind), field(t('task.source'), source), field(t('task.workspace'), workspace));
  form.append(field(t('common.title'), title), grid, field(t('task.stepsInput'), steps), submit);
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    submit.disabled = true;
    try {
      const input: NewTaskInput = {
        title: title.value.trim(), role: role.value, phase: phase.value, parent: parent.value,
        kind: kind.value === 'derived' ? 'derived' : 'main',
        derivedFrom: kind.value === 'derived' ? source.value : '',
        workspace: workspace.value === 'direct' ? 'direct' : 'isolated',
        steps: lines(steps.value),
      };
      const task = await api.createTask(project.id, input); await context.refresh(); location.hash = taskHash(project.id, task.id);
    } finally { submit.disabled = false; }
  }); };
  const detail = disclosure(t('project.detailedTask'), form); detail.id = 'add-task'; detail.open = params.has('parent') || params.has('derived'); return detail;
}

export function projectView(context: ViewContext, project: ProjectView, params: URLSearchParams): View {
  const node = el('div', 'page project-page'); const overview = el('div', 'project-overview');
  function tasksList(tasks: typeof project.tasks): HTMLElement {
    const list = el('div', 'task-list');
    for (const task of tasks) list.append(row(link(task.title, taskHash(project.id, task.id)), el('span', 'state-chip', t(`state.${task.state}`))));
    if (!tasks.length) list.append(el('p', 'muted', t('common.empty')));
    return list;
  }
  function renderOverview(): void {
    const opened = new Set(Array.from(overview.querySelectorAll('details[open]')).map(d => d.querySelector('summary')?.textContent));
    overview.replaceChildren();
    const header = el('header', 'page-header');
    header.append(el('h1', '', project.name), el('span', 'state-chip', t(`state.${project.status}`)), el('span', 'muted', t('common.updated', { at: localTime(project.updated) })));
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
      verificationConfigButton(context, project.id),
      projectTrustButton(project.id),
    );
    overview.append(header, actions, disclosure(t('project.notes'), markdown(project.description + '\n\n' + project.notes)));
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
    overview.append(rulesBox);
    if (project.phases.length) {
      const road = el('div', 'phase-road');
      for (const [i, phase] of project.phases.entries()) road.append(el('div', `phase ${phase.name === project.currentPhase ? 'current' : ''} ${phase.state === '完成' ? 'complete' : ''}`, `${i + 1} · ${phase.name}`));
      overview.append(road);
    }
    if (project.phaseOffer) overview.append(card(t('project.phaseComplete'), row(
      button(t('project.nextPhase'), async () => { await request('/api/phase/next', { project: project.id }); await context.refresh(); }, 'primary'),
      button(t('project.continuePhase'), async () => { await request('/api/phase/continue', { project: project.id }); await context.refresh(); }),
    )));
    const active = project.tasks.filter(task => task.state !== '完成');
    overview.append(card(t('project.activeTasks'), tasksList(active.filter(task => !project.currentPhase || task.phase === project.currentPhase))));
    const other = active.filter(task => !!project.currentPhase && task.phase !== project.currentPhase);
    if (other.length) {
      const sections = Array.from(new Set(other.map(task => task.phase))).map(phase => disclosure(phase || t('common.none'), tasksList(other.filter(task => task.phase === phase))));
      overview.append(disclosure(t('project.otherTasks'), ...sections));
    }
    overview.append(disclosure(t('project.completedTasks'), tasksList(project.tasks.filter(task => task.state === '完成'))));
    for (const detail of overview.querySelectorAll('details')) detail.open = opened.has(detail.querySelector('summary')?.textContent);
  }
  renderOverview(); node.append(overview);
  const draftKey = `yumeewade.quick.${project.id}`; const draft = area(readLocal<string>(draftKey, ''), `${t('project.quickPlaceholder')} · ${t(readLocal('yumeewade.enterToSend', false) ? 'chat.hintEnter' : 'chat.hintModifier')}`); draft.maxLength = context.state.limits.promptChars;
  draft.oninput = () => storeLocal(draftKey, draft.value);
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
  return { node, dispose: () => { slashCommands.dispose(); upload.dispose(); }, update: state => {
    context.state = state;
    const next = state.projects.find(p => p.id === project.id);
    if (!next) { location.hash = '#/turn'; return; }
    if (JSON.stringify(next) !== JSON.stringify(project)) { project = next; renderOverview(); }
    slashCommands.refresh();
  } };
}
