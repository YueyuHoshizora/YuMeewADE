import type { NewTaskInput, ProjectView } from '../../shared/types.ts';
import { api, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { attachments } from '../components/attachments.ts';
import { aiPicker } from '../components/picker.ts';
import { markdown } from '../components/markdown.ts';
import { area, button, card, confirmModal, disclosure, el, field, input, lines, link, projectHash, readLocal, row, run, select, storeLocal, taskHash, type View, type ViewContext } from '../components/dom.ts';
import { localTime } from '../components/display.ts';

declare global { interface Window { yumeewade?: { desktop: boolean; platform: string; pickFolder: () => Promise<string | null> }; } }

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
  form.append(field(t('project.name'), name), field(t('project.firstTask'), first), field(t('project.description'), description), field(t('project.phases'), phases), details, submit);
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    submit.disabled = true;
    try { const project = await api.createProject({ name: name.value.trim(), description: description.value.trim(), phases: lines(phases.value), body: body.value.trim(), parent: parent.value, related });
      // 建立台帳成功後立即離開此表單；即使第一輪失敗，也不能重複建立專案。
      await context.refresh(); location.hash = projectHash(project.id);
      if (first.value.trim()) { const result = await api.start({ project: project.id, text: first.value.trim(), ...context.state.settings.initial }); await context.refresh(); location.hash = taskHash(project.id, result.task.id); }
    } finally { submit.disabled = false; }
  }); };
  node.append(el('h1', '', t('project.new')), form); return { node };
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
        if (await confirmModal(t('common.archive'), t('common.confirmArchive', { name: project.name }), t('common.archive'))) {
          await request('/api/project/archive', { project: project.id }); await context.refresh(); location.hash = '#/turn';
        }
      }, 'danger'),
    );
    overview.append(header, actions, disclosure(t('project.notes'), markdown(project.description + '\n\n' + project.notes)));
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
  const draftKey = `yumeewade.quick.${project.id}`; const draft = area(readLocal<string>(draftKey, ''), t('project.quickPlaceholder')); draft.maxLength = context.state.limits.promptChars;
  draft.oninput = () => storeLocal(draftKey, draft.value);
  const pick = aiPicker(context.state, project.startPick ?? context.state.settings.initial); const upload = attachments(project.id, context.state.limits, draft);
  const start = button(t('project.start'), async () => { await upload.ready(); if (!draft.value.trim() && !upload.ids().length) return;
    const result = await api.start({ project: project.id, text: draft.value.trim(), ...pick.value(), images: upload.ids() }); storeLocal(draftKey, ''); upload.clear(); draft.value = ''; await context.refresh(); location.hash = taskHash(project.id, result.task.id);
  }, 'primary');
  draft.onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); start.click(); } };
  node.append(card(t('project.quick'), draft, upload.node, row(pick.node, start)), detailedTaskForm(context, project, params));
  return { node, dispose: upload.dispose, update: state => {
    context.state = state;
    const next = state.projects.find(p => p.id === project.id);
    if (!next) { location.hash = '#/turn'; return; }
    if (JSON.stringify(next) !== JSON.stringify(project)) { project = next; renderOverview(); }
  } };
}
