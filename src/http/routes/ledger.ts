import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { App } from '../../server/app.ts';
import type { NewProjectInput, NewTaskInput, ProjectPatch, TaskPatch } from '../../shared/types.ts';
import { AppError } from '../../shared/errors.ts';
import { phaseKey, stepsHash } from '../../ledger/completion.ts';
import { phaseTasks } from '../../state/state.ts';
import { Router, reqString } from '../router.ts';
import { TaskTemplates } from '../../ledger/task-templates.ts';
import { STEP_TEXT_MAX } from '../../ledger/tasks.ts';
import { PHASES_MAX, TASK_STATES, type BulkTaskAction, type BulkTaskResult } from '../../shared/types.ts';
import { validDue, validTag } from '../../shared/task-metadata.ts';
import { isValidTaskId } from '../../shared/names.ts';
import { log } from '../../shared/log.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('bad_request', 'patch_not_object');
  return value as Record<string, unknown>;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new AppError('bad_request');
  return value;
}
function index(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new AppError('bad_request');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new AppError('bad_request');
  return value as string[];
}

export function registerLedgerRoutes(router: Router, app: App): void {
  async function changed(action: string, project?: string, task?: string): Promise<void> {
    await app.oplog.record({ action, ...(project ? { project } : {}), ...(task ? { task } : {}) });
    app.changed(project, task);
  }
  const ids = (body: Record<string, unknown>) => ({ project: reqString(body, 'project', 120), task: reqString(body, 'task', 120) });
  const templates = new TaskTemplates(app.ws);
  const templateScope = (value: unknown): 'project' | 'workspace' => {
    if (value !== 'project' && value !== 'workspace') throw new AppError('bad_request', 'field_type', { field: 'scope' });
    return value;
  };
  router.get('/api/task/templates', async ({ query }) => {
    const project = reqString(query, 'project', 120); await app.projects.get(project);
    return { templates: await templates.list(project) };
  });
  router.post('/api/task/template/save', async ({ body }) => {
    const { project, task } = ids(body); await app.projects.get(project);
    if (body.instruction !== undefined && typeof body.instruction !== 'string') throw new AppError('bad_request', 'field_type');
    const result = await templates.saveFromTask(project, task, reqString(body, 'name', 60), typeof body.instruction === 'string' ? body.instruction : '', templateScope(body.scope));
    await changed('task.template.save', project, task); return result;
  });
  router.post('/api/task/template/delete', async ({ body }) => {
    const project = reqString(body, 'project', 120); await app.projects.get(project);
    if (body.confirm !== true) throw new AppError('bad_request');
    await templates.remove(project, templateScope(body.scope), reqString(body, 'name', 60));
    await changed('task.template.delete', project); return { ok: true };
  });
  router.post('/api/task/template/create', async ({ body }) => {
    const project = reqString(body, 'project', 120); const current = app.projects.currentPhase(await app.projects.get(project));
    const template = await templates.get(project, templateScope(body.scope), reqString(body, 'name', 60));
    const task = await app.tasks.create(project, { title: template.title, steps: template.steps, phase: current });
    await changed('task.new', project, task.id);
    return { task, instruction: template.instruction };
  });
  router.post('/api/project/new', async ({ body }) => {
    reqString(body, 'name', 60);
    if (body.verify !== undefined) {
      if (typeof body.verify !== 'string' || /[\r\n\0]/u.test(body.verify)) throw new AppError('bad_request', 'field_type', { field: 'verify' });
      if (body.verify.trim().length > 500) throw new AppError('bad_request', 'field_too_long', { field: 'verify' });
    }
    const project = await app.projects.create(body as unknown as NewProjectInput);
    await changed('project.new', project.id);
    return project;
  });
  router.post('/api/project/update', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const patch = object(body.patch);
    // Phases change only through /api/project/phases, which checks names, keeps states and moves tasks along on rename.
    if (patch.phases !== undefined) throw new AppError('bad_request', 'field_type', { field: 'phases' });
    if (patch.verify !== undefined) {
      if (typeof patch.verify !== 'string' || /[\r\n\0]/u.test(patch.verify)) throw new AppError('bad_request', 'field_type', { field: 'verify' });
      if (patch.verify.trim().length > 500) throw new AppError('bad_request', 'field_too_long', { field: 'verify' });
    }
    const result = await app.projects.update(project, patch as ProjectPatch);
    await changed('project.update', project);
    return result;
  });
  router.get('/api/project/rules', async ({ query }) => ({ text: await app.projects.readRules(reqString(query, 'project', 120)) }));
  router.post('/api/project/rules', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    if (typeof body.text !== 'string') throw new AppError('bad_request', 'field_type', { field: 'text' });
    await app.projects.writeRules(project, body.text);
    await app.oplog.record({ action: 'project.rules', project });
    return { ok: true };
  });
  router.get('/api/project/notes', async ({ query }) => ({ text: await app.projects.readNotes(reqString(query, 'project', 120)) }));
  router.post('/api/project/notes', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    if (typeof body.text !== 'string') throw new AppError('bad_request', 'field_type', { field: 'text' });
    if (typeof body.previous !== 'string') throw new AppError('bad_request', 'field_type', { field: 'previous' });
    const result = await app.projects.writeNotes(project, body.text, body.previous);
    await changed('project.notes', project);
    return result;
  });
  router.post('/api/project/archive', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const force = body.force === true;
    await app.projects.get(project);
    if (app.taskBusy(project)) throw new AppError('conflict', 'archive_project_running');
    for (const task of await app.tasks.list(project)) {
      if (!(await app.worktree.copyExists(project, task))) continue;
      if (!force) throw new AppError('conflict', 'archive_project_has_worktrees');
      const preview = await app.archive.preview(project, task.id);
      if (preview.unavailable.length) throw new AppError('conflict', 'archive_cannot_preserve');
      await app.worktree.abandon(project, task.id);
    }
    try {
      const copies = await fs.readdir(path.join(app.ws.workDir, project), { withFileTypes: true });
      if (copies.some((entry) => entry.isDirectory() || entry.isSymbolicLink())) throw new AppError('conflict', 'archive_project_has_worktrees');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await app.projects.archive(project);
    await changed('project.archive', project);
    return { archived: true };
  });
  router.post('/api/phase/next', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    if (typeof body.phase !== 'string') throw new AppError('bad_request', 'field_type', { field: 'phase' });
    const result = await app.projects.nextPhase(project, body.phase);
    await changed('phase.next', project);
    return result;
  });
  router.post('/api/phase/continue', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    if (typeof body.phase !== 'string') throw new AppError('bad_request', 'field_type', { field: 'phase' });
    const result = await app.projects.get(project);
    // A stale page must not silence the completion offer of a phase it never showed.
    if (app.projects.currentPhase(result) !== body.phase) throw new AppError('conflict', 'phase_changed');
    await app.completion.setPhaseContinued(project, phaseKey(phaseTasks(result, await app.tasks.list(project))));
    await changed('phase.continue', project);
    return result;
  });
  router.post('/api/project/phases', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    if (!Array.isArray(body.previous) || body.previous.some(name => typeof name !== 'string')) throw new AppError('bad_request', 'field_type', { field: 'previous' });
    const phases = body.phases;
    if (!Array.isArray(phases) || phases.length > PHASES_MAX || phases.some(entry => !entry || typeof entry !== 'object' || typeof entry.name !== 'string' || (entry.from !== undefined && typeof entry.from !== 'string'))) {
      throw new AppError('bad_request', 'field_type', { field: 'phases' });
    }
    const { project: result, renamed } = await app.projects.setPhases(project, body.previous as string[], (phases as { name: string; from?: string }[]).map(entry => ({ name: entry.name, ...(entry.from === undefined ? {} : { from: entry.from }) })));
    // Tasks follow a renamed phase; tasks of a removed phase keep their label and show under other phases.
    if (renamed.size) for (const task of await app.tasks.list(project)) {
      const to = renamed.get(task.phase);
      if (to !== undefined) await app.tasks.update(project, task.id, { phase: to });
    }
    await changed('project.phases', project);
    return result;
  });
  router.post('/api/order', async ({ body }) => {
    if (typeof body.parent !== 'string') throw new AppError('bad_request');
    const order = await app.order.setOrder(body.parent, strings(body.order));
    await changed('order.update');
    return { order };
  });
  router.post('/api/pin', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    await app.projects.get(project);
    const pins = await app.order.setPinned(project, boolean(body.pinned));
    await changed('project.pin', project);
    return { pins };
  });
  router.post('/api/task/new', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    reqString(body, 'title', 200);
    if (body.role && !(await app.roles()).roles[String(body.role)]) throw new AppError('bad_request', 'role_missing');
    const { project: _project, ...input } = body;
    const result = await app.tasks.create(project, input as unknown as NewTaskInput);
    await changed('task.new', project, result.id);
    return result;
  });
  router.post('/api/task/update', async ({ body }) => {
    const { project, task } = ids(body);
    const patch = object(body.patch) as TaskPatch;
    const fields = ['title', 'state', 'phase', 'role', 'parent', 'cli', 'model', 'effort', 'question', 'due', 'tags'];
    if (Object.keys(patch).some((key) => !fields.includes(key))) throw new AppError('bad_request');
    if (patch.role && !(await app.roles()).roles[patch.role]) throw new AppError('bad_request', 'role_missing');
    const result = await app.tasks.update(project, task, patch);
    if (patch.state !== undefined) {
      if (patch.state === '完成') await app.completion.approve(project, task);
      else await app.completion.revoke(project, task);
    }
    await changed('task.update', project, task);
    return result;
  });
  router.post('/api/task/bulk', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    await app.projects.get(project);
    const tasks = strings(body.tasks);
    if (!tasks.length || tasks.length > 200 || new Set(tasks).size !== tasks.length) throw new AppError('bad_request');
    for (const task of tasks) if (!isValidTaskId(task)) throw new AppError('bad_request', 'invalid_task_id');
    const action = object(body.action);
    const kind = action.kind;
    if (Object.keys(action).some(key => key !== 'kind' && key !== (kind === 'archive' ? 'confirm' : 'value'))) throw new AppError('bad_request');
    if (kind === 'state') {
      if (!TASK_STATES.some(state => state === action.value)) throw new AppError('bad_request', 'invalid_state');
    } else if (kind === 'phase') {
      if (typeof action.value !== 'string' || action.value.length > 2000) throw new AppError('bad_request', 'field_type', { field: 'phase' });
    } else if (kind === 'due') {
      if (!validDue(action.value)) throw new AppError('bad_request', 'field_type', { field: 'due' });
    } else if (kind === 'addTag' || kind === 'removeTag') {
      if (!validTag(action.value)) throw new AppError('bad_request', 'field_type', { field: 'tag' });
    } else if (kind === 'archive') {
      if (action.confirm !== true) throw new AppError('bad_request');
    } else throw new AppError('bad_request');
    const validated = action as unknown as BulkTaskAction;
    const results: BulkTaskResult[] = [];
    for (const task of tasks) {
      try {
        if (validated.kind === 'archive') await archiveTask({ project, task });
        else {
          const patch: TaskPatch = validated.kind === 'state' ? { state: validated.value }
            : validated.kind === 'phase' ? { phase: validated.value }
            : validated.kind === 'due' ? { due: validated.value } : {};
          await app.tasks.update(project, task, patch, validated.kind === 'addTag' || validated.kind === 'removeTag' ? { tag: validated.value, add: validated.kind === 'addTag' } : undefined);
          if (patch.state === '完成') await app.completion.approve(project, task);
          else if (patch.state !== undefined) await app.completion.revoke(project, task);
          await changed('task.update', project, task);
        }
        results.push({ task, ok: true });
      } catch (error) {
        if (error instanceof AppError) results.push({ task, ok: false, error: error.code, ...(error.detail ? { detail: error.detail } : {}) });
        else {
          log.error('作業批次操作失敗', error);
          results.push({ task, ok: false, error: 'internal' });
        }
      }
    }
    return { results };
  });
  router.post('/api/task/step', async ({ body }) => {
    const { project, task } = ids(body);
    const count = Number(body.add !== undefined) + Number(body.remove !== undefined) + Number(body.index !== undefined);
    // With `index`, exactly one change applies: check (`done`), rename, or move (-1/1).
    const indexed = Number(body.done !== undefined) + Number(body.rename !== undefined) + Number(body.move !== undefined);
    if (count !== 1 || indexed !== (body.index !== undefined ? 1 : 0)) throw new AppError('bad_request');
    const result = body.add !== undefined ? await app.tasks.addStep(project, task, reqString(body, 'add', 300))
      : body.remove !== undefined ? await app.tasks.removeStep(project, task, index(body.remove), reqString(body, 'text', STEP_TEXT_MAX))
      : body.rename !== undefined ? await app.tasks.editStep(project, task, index(body.index), reqString(body, 'text', STEP_TEXT_MAX), reqString(body, 'rename', STEP_TEXT_MAX))
      : body.move !== undefined ? await app.tasks.moveStep(project, task, index(body.index), reqString(body, 'text', STEP_TEXT_MAX), body.move as number)
      : await app.tasks.setStep(project, task, index(body.index), boolean(body.done), reqString(body, 'text', STEP_TEXT_MAX));
    await changed('task.step', project, task);
    return result;
  });
  router.get('/api/task/sections', async ({ query }) => app.tasks.sections(reqString(query, 'project', 120), reqString(query, 'task', 120)));
  router.post('/api/task/memo', async ({ body }) => {
    const { project, task } = ids(body);
    const result = await app.tasks.appendMemo(project, task, reqString(body, 'text', 300));
    await changed('task.memo', project, task);
    return result;
  });
  router.post('/api/task/completion', async ({ body }) => {
    const { project, task } = ids(body);
    const current = await app.tasks.get(project, task);
    let result = current;
    if (body.action === 'approve') {
      result = await app.tasks.update(project, task, { state: '完成' });
      await app.completion.approve(project, task);
    } else if (body.action === 'continue') {
      await app.completion.setContinued(project, task, stepsHash(current.steps));
      if (current.state === '完成') result = await app.tasks.update(project, task, { state: '進行中' });
      await app.completion.revoke(project, task);
    } else throw new AppError('bad_request');
    await changed(`task.${String(body.action)}`, project, task);
    return result;
  });
  async function archiveTask(body: Record<string, unknown>): Promise<{ archived: true }> {
    const { project, task } = ids(body);
    await app.tasks.get(project, task);
    if (app.taskBusy(project, task)) throw new AppError('conflict', 'archive_while_running');
    if (await app.worktree.exists(project, task)) {
      if (body.force !== true) throw new AppError('conflict', 'archive_has_worktree');
      const preview = await app.archive.preview(project, task);
      if (preview.unavailable.length) throw new AppError('conflict', 'archive_cannot_preserve');
      await app.worktree.abandon(project, task);
    }
    await app.tasks.archive(project, task);
    await app.completion.revoke(project, task);
    app.runner.markRead(project, task);
    await changed('task.archive', project, task);
    return { archived: true };
  }
  router.post('/api/task/archive', async ({ body }) => archiveTask(body));
  router.post('/api/task/read', async ({ body }) => {
    const { project, task } = ids(body);
    await app.tasks.get(project, task);
    app.runner.markRead(project, task);
    app.changed(project, task);
    return { ok: true };
  });
}
