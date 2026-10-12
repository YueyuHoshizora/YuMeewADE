import type { App } from '../server/app.ts';
import type { AiPick, AppState, Project, Roles, Task, TaskView } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathExists, readJson } from '../shared/fsx.ts';
import { phaseKey, stepsHash } from '../ledger/completion.ts';

/** Legacy projects without any matching phase assignments use all their tasks. */
export function phaseTasks(project: Project, tasks: Task[]): Task[] {
  const names = new Set(project.phases.map((phase) => phase.name));
  const current = project.phases.find((phase) => phase.state !== '完成')?.name;
  return tasks.some((task) => names.has(task.phase)) ? tasks.filter((task) => task.phase === current) : tasks;
}

async function hasChat(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).size > 0; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export type StateSnapshot = Omit<AppState, 'running' | 'unread' | 'usage'>;


export async function buildState(app: App): Promise<StateSnapshot> {
  const skippedProjects: string[] = []; const unreadable: string[] = [];
  // A hand-broken roles.yaml is listed with the other unreadable ledger files instead of failing every page; runs that need roles still report it.
  const loadRoles = app.roles().catch((error: unknown) => {
    if (!(error instanceof AppError && error.detail === 'file_corrupt')) throw error;
    unreadable.push(path.relative(app.ws.root, app.ws.rolesFile));
    return { roles: Object.create(null) as Roles['roles'] };
  });
  const [projects, savedOrder, settings, roles, ais] = await Promise.all([
    app.projects.list(skippedProjects), app.order.get(), app.settings.get(), loadRoles, app.ai.list(),
  ]);
  // Joined directly: a skipped folder name may not pass the project-name whitelist that ws.projectFile enforces.
  for (const id of skippedProjects) unreadable.push(path.relative(app.ws.root, path.join(app.ws.projectsDir, id, 'PROJECT.md')));
  const views = await Promise.all(projects.map(async (project) => {
    const skippedTasks: string[] = [];
    const tasks = await app.tasks.list(project.id, skippedTasks);
    for (const name of skippedTasks) unreadable.push(path.relative(app.ws.root, path.join(app.ws.tasksDir(project.id), name)));
    const taskViews: TaskView[] = await Promise.all(tasks.map(async (task) => {
      const [approved, continued, copy, chat] = await Promise.all([
        app.completion.isApproved(project.id, task.id), app.completion.continued(project.id, task.id), app.worktree.copyExists(project.id, task),
        hasChat(app.ws.chatFile(project.id, task.id, 'jsonl')),
      ]);
      return { ...task, confirm: task.state === '完成' ? !approved : task.steps.length > 0 && task.steps.every((step) => step.done) && continued !== stepsHash(task.steps), copy, copyMissing: Boolean(task.workdir) && !copy, hasChat: chat };
    }));
    const bodyPath = app.projects.bodyPath(project);
    const currentPhase = app.projects.currentPhase(project);
    const group = phaseTasks(project, tasks);
    const [isGit, startPick, continued, body] = await Promise.all([
      pathExists(path.join(bodyPath, '.git')), readJson<AiPick | null>(app.ws.startPickFile(project.id), null), app.completion.phaseContinued(project.id),
      fs.stat(bodyPath).catch(() => null),
    ]);
    return { ...project, tasks: taskViews, currentPhase, phaseOffer: Boolean(currentPhase) && group.length > 0 && group.every((task) => task.state === '完成') && continued !== phaseKey(group), isGit, bodyPath, bodyMissing: !body?.isDirectory(), dir: app.ws.projectDir(project.id), startPick, pinned: savedOrder.pins.includes(project.id) };
  }));
  const order: Record<string, string[]> = {};
  for (const project of projects) {
    if (order[project.parent]) continue;
    const ids = projects.filter((child) => child.parent === project.parent).map((child) => child.id);
    const listed = (savedOrder.order[project.parent] ?? []).filter((id, index, list) => ids.includes(id) && list.indexOf(id) === index);
    order[project.parent] = [...listed, ...ids.filter((id) => !listed.includes(id))];
  }
  const { promptChars, queueLength, concurrentRuns, uploadBytes, imagesPerSend } = app.config.limits;
  return { version: app.version, root: app.ws.root, projects: views, order, ais, settings, roles, limits: { promptChars, queueLength, concurrentRuns, uploadBytes, imagesPerSend }, unreadable: unreadable.sort() };
}
