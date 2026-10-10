import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { App } from '../../server/app.ts';
import type { NewProjectInput, NewTaskInput, ProjectPatch, TaskPatch } from '../../shared/types.ts';
import { AppError } from '../../shared/errors.ts';
import { phaseKey, stepsHash } from '../../ledger/completion.ts';
import { phaseTasks } from '../../state/state.ts';
import { Router, reqString } from '../router.ts';

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
  router.post('/api/project/archive', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    await app.projects.get(project);
    if (app.runner.running().some((run) => run.project === project)) throw new AppError('conflict', 'archive_project_running');
    for (const task of await app.tasks.list(project)) {
      if (await app.worktree.exists(project, task.id)) throw new AppError('conflict', 'archive_project_has_worktrees');
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
    const result = await app.projects.nextPhase(project);
    await changed('phase.next', project);
    return result;
  });
  router.post('/api/phase/continue', async ({ body }) => {
    const project = reqString(body, 'project', 120);
    const result = await app.projects.get(project);
    await app.completion.setPhaseContinued(project, phaseKey(phaseTasks(result, await app.tasks.list(project))));
    await changed('phase.continue', project);
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
    const fields = ['title', 'state', 'phase', 'role', 'parent', 'cli', 'model', 'effort', 'question'];
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
  router.post('/api/task/step', async ({ body }) => {
    const { project, task } = ids(body);
    const count = Number(body.add !== undefined) + Number(body.remove !== undefined) + Number(body.index !== undefined);
    if (count !== 1) throw new AppError('bad_request');
    const result = body.add !== undefined ? await app.tasks.addStep(project, task, reqString(body, 'add', 300))
      : body.remove !== undefined ? await app.tasks.removeStep(project, task, index(body.remove))
      : await app.tasks.setStep(project, task, index(body.index), boolean(body.done));
    await changed('task.step', project, task);
    return result;
  });
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
  router.post('/api/task/archive', async ({ body }) => {
    const { project, task } = ids(body);
    await app.tasks.get(project, task);
    if (app.runner.isRunning(project, task)) throw new AppError('conflict', 'archive_while_running');
    if (await app.worktree.exists(project, task)) throw new AppError('conflict', 'archive_has_worktree');
    await app.tasks.archive(project, task);
    await app.completion.revoke(project, task);
    app.runner.markRead(project, task);
    await changed('task.archive', project, task);
    return { archived: true };
  });
  router.post('/api/task/read', async ({ body }) => {
    const { project, task } = ids(body);
    await app.tasks.get(project, task);
    app.runner.markRead(project, task);
    app.changed(project, task);
    return { ok: true };
  });
}
