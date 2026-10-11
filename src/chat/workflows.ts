import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { CompletionStore } from '../ledger/completion.ts';
import type { ChatRunner } from './runner.ts';
import type { AiPick, RoleSlot, Roles, WorkflowPlan, WorkflowStep, ReviewResult } from '../shared/types.ts';
import { HUMAN } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { readJson, writeJson, withFileLocks } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';

interface WorkflowDeps {
  ws: Workspace;
  tasks: TaskLedger;
  completion: CompletionStore;
  runner: ChatRunner;
  roles: () => Promise<Roles>;
  available: (ai: string) => Promise<boolean>;
  review: (project: string, task: string, input: { ai: string; model?: string; effort?: string; text: string }) => Promise<ReviewResult>;
  stopReview: (project: string, task: string) => boolean;
  changed: (project: string, task: string) => void;
  promptChars: number;
}
const empty = (): WorkflowPlan => ({ dependencies: [], steps: [], cursor: 0, state: 'ready', results: [] });

/** Persist intent and checkpoints; restarting the core never grants permission to resume. */
export class WorkflowService {
  private readonly jobs = new Map<string, { stopped: boolean; done: Promise<void> }>();
  private readonly deps: WorkflowDeps;
  constructor(deps: WorkflowDeps) { this.deps = deps; }
  private key(p: string, t: string): string { return `${p}\0${t}`; }
  private file(p: string, t: string): string { return path.join(this.deps.ws.projectDir(p), '.ai', 'workflows', `${t}.json`); }
  isBusy(project?: string, task?: string): boolean {
    if (project === undefined) return this.jobs.size > 0;
    if (task !== undefined) return this.jobs.has(this.key(project, task));
    return [...this.jobs.keys()].some(key => key.startsWith(`${project}\0`));
  }

  async assertCanSend(p: string, t: string, workflow: boolean): Promise<void> {
    if (!workflow && this.isBusy(p, t)) throw new AppError('conflict', 'workflow_busy');
    await this.assertDependencies(p, t);
  }

  async get(p: string, t: string): Promise<WorkflowPlan> {
    await this.deps.tasks.get(p, t);
    const plan = await readJson<WorkflowPlan>(this.file(p, t), empty());
    if (!Array.isArray(plan.dependencies) || !Array.isArray(plan.steps) || !Array.isArray(plan.results)
      || !Number.isSafeInteger(plan.cursor) || plan.cursor < 0 || plan.cursor > plan.steps.length) throw new AppError('conflict', 'workflow_invalid');
    if (plan.state === 'running' && !this.jobs.has(this.key(p, t))) {
      plan.state = 'paused'; plan.reason = 'workflow_interrupted';
      await writeJson(this.file(p, t), plan);
    }
    return plan;
  }

  async configure(p: string, t: string, dependencies: string[], steps: WorkflowStep[]): Promise<WorkflowPlan> {
    await this.deps.tasks.get(p, t);
    if (this.jobs.has(this.key(p, t)) || this.deps.runner.isRunning(p, t)) throw new AppError('conflict', 'workflow_busy');
    if (!Array.isArray(dependencies) || dependencies.length > 50 || new Set(dependencies).size !== dependencies.length
      || !dependencies.every(d => typeof d === 'string' && d !== t)
      || !Array.isArray(steps) || steps.length > 20) throw new AppError('bad_request', 'workflow_invalid');
    const roles = await this.deps.roles();
    for (const step of steps) {
      if (!step || typeof step.role !== 'string' || !roles.roles[step.role] || typeof step.text !== 'string'
        || !step.text.trim() || step.text.length > this.deps.promptChars || typeof step.review !== 'boolean') throw new AppError('bad_request', 'workflow_invalid');
    }
    const file = this.file(p, t);
    return withFileLocks([path.join(this.deps.ws.projectDir(p), '.ai', 'workflows')], async () => {
      if (this.jobs.has(this.key(p, t)) || this.deps.runner.isRunning(p, t)) throw new AppError('conflict', 'workflow_busy');
      const visited = new Set<string>();
      const visit = async (id: string, ancestors: Set<string>): Promise<void> => {
        if (id === t || ancestors.has(id)) throw new AppError('bad_request', 'workflow_cycle');
        if (visited.has(id)) return;
        if (visited.size > 2000) throw new AppError('bad_request', 'workflow_invalid');
        const next = new Set(ancestors).add(id);
        for (const dependency of (await this.get(p, id)).dependencies) await visit(dependency, next);
        visited.add(id);
      };
      for (const id of dependencies) await visit(id, new Set());
      const prior = await this.get(p, t);
      for (let index = 0; index < prior.cursor; index++) {
        if (JSON.stringify(prior.steps[index]) !== JSON.stringify(steps[index])) throw new AppError('conflict', 'workflow_invalid');
      }
      const plan: WorkflowPlan = { ...prior, dependencies: [...dependencies], steps: steps.map(s => ({ ...s })),
        state: prior.cursor === steps.length ? 'completed' : 'ready' };
      delete plan.reason;
      await writeJson(file, plan);
      this.deps.changed(p, t);
      return plan;
    });
  }

  async assertDependencies(p: string, t: string): Promise<void> {
    for (const dependency of (await this.get(p, t)).dependencies) {
      const task = await this.deps.tasks.get(p, dependency);
      if (task.state !== '完成' || !await this.deps.completion.isApproved(p, dependency)) throw new AppError('conflict', 'workflow_dependencies');
    }
  }
  private async resolveStep(step: WorkflowStep): Promise<RoleSlot | null> {
    const role = (await this.deps.roles()).roles[step.role];
    if (!role) throw new AppError('bad_request', 'workflow_invalid');
    if (role.main.cli === HUMAN) return null;
    if (await this.deps.available(role.main.cli)) return role.main;
    if (!role.backup || role.backup.cli === HUMAN || !await this.deps.available(role.backup.cli)) throw new AppError('unavailable', 'cli_unavailable');
    return role.backup;
  }

  async nextSelection(p: string, t: string): Promise<AiPick | null> {
    const plan = await this.get(p, t); const step = plan.steps[plan.cursor];
    if (!step) return null;
    const slot = await this.resolveStep(step);
    return slot ? { ai: slot.cli, model: slot.model, effort: slot.effort } : null;
  }

  async start(p: string, t: string): Promise<WorkflowPlan> {
    const key = this.key(p, t);
    if (this.jobs.has(key) || this.deps.runner.isRunning(p, t)) throw new AppError('conflict', 'workflow_busy');
    // Reserve synchronously so a second start cannot pass while the plan is loading.
    const completion = Promise.withResolvers<void>();
    const job = { stopped: false, done: completion.promise };
    this.jobs.set(key, job);
    try {
      await this.assertDependencies(p, t);
      const plan = await this.get(p, t);
      if (!plan.steps.length || plan.cursor >= plan.steps.length) throw new AppError('bad_request', 'workflow_invalid');
      plan.state = job.stopped ? 'paused' : 'running';
      if (job.stopped) plan.reason = 'workflow_stopped'; else delete plan.reason;
      await writeJson(this.file(p, t), plan);
      void this.execute(p, t, plan, job).finally(() => { this.jobs.delete(key); this.deps.changed(p, t); completion.resolve(); });
      this.deps.changed(p, t);
      return plan;
    } catch (error) { this.jobs.delete(key); completion.resolve(); throw error; }
  }

  private async execute(p: string, t: string, plan: WorkflowPlan, job: { stopped: boolean }): Promise<void> {
    try {
      while (plan.cursor < plan.steps.length && !job.stopped) {
        await this.assertDependencies(p, t);
        const step = plan.steps[plan.cursor]!;
        const slot = await this.resolveStep(step);
        if (!slot) { plan.state = 'paused'; plan.reason = 'workflow_human'; break; }
        let result: { request: string; ok: boolean; approved?: boolean; structured?: boolean; text?: string; snapshot?: { id: string } };
        if (job.stopped) break;
        if (step.review) result = await this.deps.review(p, t, { ai: slot.cli, model: slot.model, effort: slot.effort, text: step.text });
        else {
          const sent = await this.deps.runner.send({ project: p, task: t, text: step.text, ai: slot.cli, model: slot.model, effort: slot.effort }, { workflow: true });
          await this.deps.runner.whenTaskIdle(p, t);
          const reply = await this.deps.runner.outcome(p, t, sent.request);
          result = { request: sent.request, ...(reply?.text === undefined ? {} : { text: reply.text }), ok: reply?.role === 'assistant' && !reply.error && !reply.stopped && !reply.asks?.length };
        }
        plan.results.push({ step: plan.cursor, role: step.role, ai: slot.cli, request: result.request,
          ok: result.ok && (!step.review || (result.approved === true && result.structured === true)), ...(result.approved === undefined ? {} : { approved: result.approved }),
          ...(result.text === undefined ? {} : { output: result.text }), ...(result.snapshot ? { reviewSnapshot: result.snapshot.id } : {}), at: new Date().toISOString() });
        if (job.stopped) break;
        const task = await this.deps.tasks.get(p, t);
        if (!result.ok || (step.review && (result.approved !== true || result.structured !== true)) || task.state === '等待回覆') { plan.state = 'failed'; plan.reason = 'workflow_step_failed'; break; }
        plan.cursor++;
        await writeJson(this.file(p, t), plan);
        this.deps.changed(p, t);
      }
      if (job.stopped) { plan.state = 'paused'; plan.reason = 'workflow_stopped'; }
      else if (plan.cursor === plan.steps.length) plan.state = 'completed';
    } catch (error) {
      plan.state = job.stopped ? 'paused' : 'failed';
      plan.reason = job.stopped ? 'workflow_stopped' : error instanceof AppError ? error.detail ?? error.code : 'workflow_step_failed';
    } finally {
      await writeJson(this.file(p, t), plan).catch(error => { log.error('角色流程狀態保存失敗', error, { project: p, task: t }); });
    }
  }

  /** An explicit human approval advances only a human-owned paused step. */
  async approveHuman(p: string, t: string, evidence: string): Promise<WorkflowPlan> {
    if (this.jobs.has(this.key(p, t))) throw new AppError('conflict', 'workflow_busy');
    if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 10000) throw new AppError('bad_request', 'workflow_invalid');
    const plan = await this.get(p, t);
    const step = plan.steps[plan.cursor];
    if (!step || plan.state !== 'paused' || (await this.deps.roles()).roles[step.role]?.main.cli !== HUMAN) throw new AppError('conflict', 'workflow_invalid');
    plan.results.push({ step: plan.cursor, role: step.role, ai: HUMAN, request: '', ok: true, approved: true, evidence, at: new Date().toISOString() });
    plan.cursor++;
    plan.state = plan.cursor === plan.steps.length ? 'completed' : 'ready';
    delete plan.reason;
    await writeJson(this.file(p, t), plan);
    this.deps.changed(p, t);
    return plan;
  }
  /** Explicit reruns preserve attempts but revoke downstream checkpoints. */
  async rerun(p: string, t: string, from: number): Promise<WorkflowPlan> {
    if (this.jobs.has(this.key(p, t)) || this.deps.runner.isRunning(p, t)) throw new AppError('conflict', 'workflow_busy');
    const plan = await this.get(p, t);
    if (!Number.isSafeInteger(from) || from < 0 || from > plan.cursor || from >= plan.steps.length) throw new AppError('bad_request', 'workflow_invalid');
    const at = new Date().toISOString();
    plan.results.forEach((result, index) => { if (!result.invalidatedAt && (result.step ?? index) >= from) result.invalidatedAt = at; });
    plan.cursor = from; plan.state = 'ready'; delete plan.reason;
    await writeJson(this.file(p, t), plan); this.deps.changed(p, t);
    return plan;
  }

  async stop(p: string, t: string): Promise<void> {
    const job = this.jobs.get(this.key(p, t));
    if (!job) return;
    job.stopped = true;
    this.deps.stopReview(p, t);
    await this.deps.runner.stop(p, t);
    await job.done;
  }

  async close(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map(key => { const [p, t] = key.split('\0'); return this.stop(p!, t!); }));
  }
}
