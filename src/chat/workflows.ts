import path from 'node:path';
import type { Workspace } from '../ledger/workspace.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import type { CompletionStore } from '../ledger/completion.ts';
import type { ChatRunner } from './runner.ts';
import type { ChatStore } from './store.ts';
import type { AiPick, RoleSlot, Roles, ReviewResult } from '../shared/types.ts';
import type { WorkflowPlan, WorkflowStep, WorkflowResult } from '../shared/workflow-graph.ts';
import { normalizeGraph, validateGraph, downstreamNodes } from '../shared/workflow-graph.ts';
import { HUMAN } from '../shared/types.ts';
import { AppError } from '../shared/errors.ts';
import { readJson, writeJson, withFileLocks } from '../shared/fsx.ts';
import { log } from '../shared/log.ts';
import { HANDOFF_NOTICE } from './prompt.ts';

interface WorkflowDeps {
  ws: Workspace; tasks: TaskLedger; completion: CompletionStore; runner: ChatRunner;
  store: Pick<ChatStore, 'readLog'>;
  roles: () => Promise<Roles>; available: (ai: string) => Promise<boolean>;
  review: (project: string, task: string, input: { ai: string; model?: string; effort?: string; text: string }) => Promise<ReviewResult>;
  stopReview: (project: string, task: string) => boolean;
  changed: (project: string, task: string) => void; promptChars: number;
  beforeStart: (project: string, task: string) => Promise<void>;
  prepareBranch: (project: string, task: string) => Promise<void>;
  isTaskBusy: (project: string, task: string) => boolean;
  maxParallel: number;
}
interface Job { stopped: boolean; done: Promise<void>; branches: Set<string> }
const empty = (): WorkflowPlan => ({ dependencies: [], steps: [], cursor: 0, state: 'ready', results: [], revision: 0, nodeStates: {}, branchTasks: {} });

/** Checkpoints grant no restart permission; every executable node has a real isolated branch task. */
export class WorkflowService {
  private readonly jobs = new Map<string, Job>();
  private readonly deps: WorkflowDeps;
  constructor(deps: WorkflowDeps) { this.deps = deps; }
  private key(p: string, t: string): string { return `${p}\0${t}`; }
  private file(p: string, t: string): string { this.deps.ws.taskFile(p, t); return path.join(this.deps.ws.projectDir(p), '.ai', 'workflows', `${t}.json`); }
  isBusy(project?: string, task?: string): boolean {
    if (project === undefined) return this.jobs.size > 0;
    if (task !== undefined) return this.jobs.has(this.key(project, task)) || [...this.jobs].some(([key, job]) => key.startsWith(`${project}\0`) && job.branches.has(task));
    return [...this.jobs.keys()].some(key => key.startsWith(`${project}\0`));
  }
  async assertCanSend(p: string, t: string, workflow: boolean): Promise<void> {
    if (!workflow && this.isBusy(p, t)) throw new AppError('conflict', 'workflow_busy');
    await this.assertDependencies(p, t);
  }
  async get(p: string, t: string): Promise<WorkflowPlan> {
    await this.deps.tasks.get(p, t);
    const plan = await readJson<WorkflowPlan>(this.file(p, t), empty());
    if (!Array.isArray(plan.dependencies) || !Array.isArray(plan.steps) || !Array.isArray(plan.results) || !Number.isSafeInteger(plan.cursor) || plan.cursor < 0 || plan.cursor > plan.steps.length) throw new AppError('conflict', 'workflow_invalid');
    plan.steps = normalizeGraph(plan.steps);
    if (!validateGraph(plan.steps)) throw new AppError('conflict', 'workflow_cycle');
    plan.revision ??= 0; plan.branchTasks ??= {};
    plan.nodeStates ??= Object.fromEntries(plan.steps.map((s, index) => [s.id!, index < plan.cursor ? 'succeeded' : 'pending']));
    if (plan.state === 'running' && !this.jobs.has(this.key(p, t))) {
      plan.state = 'paused'; plan.reason = 'workflow_interrupted';
      for (const [id, state] of Object.entries(plan.nodeStates)) if (state === 'running') plan.nodeStates[id] = 'pending';
      await writeJson(this.file(p, t), plan);
    }
    return plan;
  }
  async configure(p: string, t: string, dependencies: string[], raw: WorkflowStep[], revision?: number): Promise<WorkflowPlan> {
    await this.deps.tasks.get(p, t);
    if (this.isBusy(p, t) || this.deps.isTaskBusy(p, t)) throw new AppError('conflict', 'workflow_busy');
    if (!Array.isArray(dependencies) || dependencies.length > 50 || new Set(dependencies).size !== dependencies.length || !dependencies.every(d => typeof d === 'string' && d !== t) || !Array.isArray(raw) || raw.length > 20 || raw.some(step => !step || typeof step !== 'object')) throw new AppError('bad_request', 'workflow_invalid');
    const steps = normalizeGraph(raw); const roles = await this.deps.roles();
    if (!validateGraph(steps)) throw new AppError('bad_request', 'workflow_cycle');
    for (const step of steps) if (!step || typeof step.role !== 'string' || !roles.roles[step.role] || typeof step.text !== 'string' || !step.text.trim() || step.text.length > this.deps.promptChars || typeof step.review !== 'boolean') throw new AppError('bad_request', 'workflow_invalid');
    return withFileLocks([path.join(this.deps.ws.projectDir(p), '.ai', 'workflows')], async () => {
      if (this.isBusy(p, t) || this.deps.isTaskBusy(p, t)) throw new AppError('conflict', 'workflow_busy');
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
      if (prior.state === 'completed') throw new AppError('conflict', 'workflow_invalid');
      if (revision !== undefined && revision !== prior.revision) throw new AppError('conflict');
      const changed = new Set<string>();
      for (const old of prior.steps) if (JSON.stringify(old) !== JSON.stringify(steps.find(s => s.id === old.id))) for (const id of downstreamNodes(prior.steps, old.id!)) changed.add(id);
      for (const step of steps) if (!prior.steps.some(s => s.id === step.id)) changed.add(step.id!);
      if (JSON.stringify(dependencies) !== JSON.stringify(prior.dependencies)) steps.forEach(s => changed.add(s.id!));
      const at = new Date().toISOString();
      for (const result of prior.results) if (changed.has(result.node ?? prior.steps[result.step ?? 0]?.id ?? '')) result.invalidatedAt ??= at;
      if (this.isBusy(p, t) || this.deps.isTaskBusy(p, t)) throw new AppError('conflict', 'workflow_busy');
      const plan: WorkflowPlan = { ...prior, dependencies: [...dependencies], steps, revision: prior.revision! + 1, state: 'ready', nodeStates: Object.fromEntries(steps.map(s => [s.id!, changed.has(s.id!) ? 'pending' : prior.nodeStates![s.id!] ?? 'pending'])) };
      delete plan.reason; this.updateCursor(plan); await writeJson(this.file(p, t), plan); this.deps.changed(p, t); return plan;
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
  private updateCursor(plan: WorkflowPlan): void {
    plan.cursor = plan.steps.filter(s => ['succeeded', 'skipped'].includes(plan.nodeStates![s.id!]!)).length;
  }
  private latest(plan: WorkflowPlan, id: string): WorkflowResult | undefined {
    return plan.results.findLast(r => !r.invalidatedAt && (r.node ?? plan.steps[r.step ?? 0]?.id) === id);
  }
  private ready(plan: WorkflowPlan): WorkflowStep[] {
    const terminal = ['succeeded', 'failed', 'skipped'];
    return plan.steps.filter(s => plan.nodeStates![s.id!] === 'pending' && s.dependsOn!.every(id => terminal.includes(plan.nodeStates![id]!)));
  }
  async nextSelection(p: string, t: string): Promise<AiPick | null> {
    const plan = await this.get(p, t); const step = this.ready(plan)[0]; if (!step) return null;
    const slot = await this.resolveStep(step); return slot ? { ai: slot.cli, model: slot.model, effort: slot.effort } : null;
  }
  async start(p: string, t: string): Promise<WorkflowPlan> {
    const key = this.key(p, t);
    if (this.isBusy(p, t) || this.deps.isTaskBusy(p, t) || this.jobs.size >= Math.max(1, this.deps.maxParallel)) throw new AppError('conflict', 'workflow_busy');
    const completion = Promise.withResolvers<void>(); const job: Job = { stopped: false, done: completion.promise, branches: new Set() }; this.jobs.set(key, job);
    try {
      await this.deps.beforeStart(p, t); await this.assertDependencies(p, t);
      const plan = await this.get(p, t);
      const roles = await this.deps.roles();
      const waiting = plan.steps.filter(step => plan.nodeStates![step.id!] === 'human' && !step.review && roles.roles[step.role]?.main.cli !== HUMAN);
      if (!plan.steps.length || !plan.steps.some(s => plan.nodeStates![s.id!] === 'pending') && !waiting.length) throw new AppError('bad_request', 'workflow_invalid');
      for (const step of waiting) {
        const branch = Object.hasOwn(plan.branchTasks!, step.id!) ? plan.branchTasks![step.id!] : undefined;
        if (!branch || this.deps.isTaskBusy(p, branch)) throw new AppError('conflict', 'workflow_busy');
        const task = await this.deps.tasks.get(p, branch);
        if (task.state === '等待回覆') continue;
        const log = await this.deps.store.readLog(p, branch);
        const reply = log.filter(row => row.role !== 'event').at(-1);
        if (reply?.role !== 'assistant' || reply.request === this.latest(plan, step.id!)?.request) continue;
        const ok = !reply.error && !reply.stopped && !reply.asks?.length;
        plan.results.push({ step: plan.steps.indexOf(step), node: step.id!, task: branch, role: step.role, ai: reply.ai, request: reply.request, at: reply.at, ok, output: reply.text });
        plan.nodeStates![step.id!] = ok ? 'succeeded' : 'failed';
      }
      this.updateCursor(plan); plan.revision!++;
      plan.state = job.stopped ? 'paused' : 'running'; delete plan.reason; await writeJson(this.file(p, t), plan);
      void this.execute(p, t, plan, job).finally(() => { this.jobs.delete(key); this.deps.changed(p, t); completion.resolve(); });
      this.deps.changed(p, t); return structuredClone(plan);
    } catch (error) { this.jobs.delete(key); completion.resolve(); throw error; }
  }
  private async executeNode(p: string, t: string, plan: WorkflowPlan, step: WorkflowStep, job: Job): Promise<void> {
    const id = step.id!; const index = plan.steps.indexOf(step);
    const slot = await this.resolveStep(step);
    if (!slot) { plan.nodeStates![id] = 'human'; return; }
    if (job.stopped) return;
    let branch = Object.hasOwn(plan.branchTasks!, id) ? plan.branchTasks![id] : undefined;
    if (!branch) {
      branch = (await this.deps.tasks.create(p, { title: `${t} · ${id} · ${step.role}`, role: step.role, parent: t, kind: 'derived', derivedFrom: t, workspace: 'isolated' })).id;
      Object.defineProperty(plan.branchTasks!, id, { value: branch, enumerable: true, writable: true, configurable: true });
    }
    job.branches.add(branch);
    if (this.deps.runner.isRunning(p, branch)) throw new AppError('conflict', 'workflow_busy');
    await this.deps.beforeStart(p, branch); await this.deps.prepareBranch(p, branch);
    const task = await this.deps.tasks.get(p, branch);
    if (task.workspace !== 'isolated' || !task.workdir) throw new AppError('conflict', 'workflow_invalid');
    const otherDirs = await Promise.all([...job.branches].filter(b => b !== branch).map(b => this.deps.tasks.get(p, b)));
    if (otherDirs.some(other => other.workdir && path.resolve(other.workdir) === path.resolve(task.workdir))) throw new AppError('conflict', 'workflow_invalid');
    const outputs = step.dependsOn!.map(dependency => {
      const previous = this.latest(plan, dependency);
      return previous ? `[${dependency} · task ${previous.task ?? t} · ${previous.ok ? 'success' : 'failure'}]\n${previous.output ?? previous.evidence ?? ''}` : `[${dependency} · skipped]`;
    });
    const background = outputs.length ? `<workflow_outputs>\n${HANDOFF_NOTICE}\n${outputs.join('\n\n')}\n</workflow_outputs>\n\n` : '';
    const text = `${background}${step.text}`;
    if (text.length > this.deps.promptChars) throw new AppError('bad_request', 'workflow_invalid');
    if (job.stopped) return;
    plan.nodeStates![id] = 'running';
    await withFileLocks([this.file(p, t)], () => writeJson(this.file(p, t), structuredClone(plan)));
    let result: { request: string; ok: boolean; approved?: boolean; structured?: boolean; text?: string; snapshot?: { id: string } };
    try {
      if (step.review) result = await this.deps.review(p, branch, { ai: slot.cli, model: slot.model, effort: slot.effort, text });
      else {
        const sent = await this.deps.runner.send({ project: p, task: branch, text, ai: slot.cli, model: slot.model, effort: slot.effort }, { workflow: true });
        await this.deps.runner.whenTaskIdle(p, branch); const reply = await this.deps.runner.outcome(p, branch, sent.request);
        result = { request: sent.request, ...(reply?.text === undefined ? {} : { text: reply.text }), ok: reply?.role === 'assistant' && !reply.error && !reply.stopped && !reply.asks?.length };
      }
      const needsHuman = (await this.deps.tasks.get(p, branch)).state === '等待回覆';
      const ok = result.ok && !needsHuman && (!step.review || result.approved === true && result.structured === true);
      plan.results.push({ step: index, node: id, task: branch, role: step.role, ai: slot.cli, request: result.request, ok, ...(result.approved === undefined ? {} : { approved: result.approved }), ...(result.text === undefined ? {} : { output: result.text }), ...(result.snapshot ? { reviewSnapshot: result.snapshot.id } : {}), at: new Date().toISOString() });
      plan.nodeStates![id] = job.stopped ? 'pending' : needsHuman ? 'human' : ok ? 'succeeded' : 'failed';
    } catch (error) {
      plan.nodeStates![id] = job.stopped ? 'pending' : 'failed';
      plan.results.push({ step: index, node: id, task: branch, role: step.role, ai: slot.cli, request: '', ok: false, at: new Date().toISOString() });
      if (!(error instanceof AppError)) log.error('角色流程階段失敗', error, { project: p, task: t });
    } finally {
      await withFileLocks([this.file(p, t)], () => writeJson(this.file(p, t), structuredClone(plan)));
    }
  }
  private async execute(p: string, t: string, plan: WorkflowPlan, job: Job): Promise<void> {
    try {
      while (!job.stopped) {
        await this.assertDependencies(p, t);
        if (Object.values(plan.nodeStates!).includes('human')) { plan.state = 'paused'; plan.reason = 'workflow_human'; break; }
        const ready = this.ready(plan);
        for (const step of ready) {
          const condition = step.condition; const prior = condition ? this.latest(plan, condition.node) : undefined;
          const selected = !condition || (condition.outcome === 'failure' ? plan.nodeStates![condition.node] === 'failed' : condition.outcome === 'approved' ? prior?.approved === true : plan.nodeStates![condition.node] === 'succeeded');
          const blocked = step.dependsOn!.some(id => plan.nodeStates![id] === 'skipped' || plan.nodeStates![id] === 'failed' && !(condition?.node === id && condition.outcome === 'failure'));
          // Join accepts skipped alternatives, but never silently accepts failed unhandled inputs.
          const joinBlocked = step.kind === 'join' && step.dependsOn!.some(id => plan.nodeStates![id] === 'failed' && !(condition?.node === id && condition.outcome === 'failure'));
          if (!selected || (step.kind === 'join' ? joinBlocked : blocked)) plan.nodeStates![step.id!] = 'skipped';
        }
        const runnable = ready.filter(s => plan.nodeStates![s.id!] === 'pending');
        this.updateCursor(plan);
        if (!runnable.length) {
          if (this.ready(plan).length) continue;
          const failed = plan.steps.some(s => plan.nodeStates![s.id!] === 'failed' && !plan.steps.some(next => next.condition?.node === s.id && next.condition?.outcome === 'failure' && plan.nodeStates![next.id!] === 'succeeded'));
          plan.state = failed || Object.values(plan.nodeStates!).includes('pending') ? 'failed' : 'completed';
          if (plan.state === 'failed') plan.reason = 'workflow_step_failed'; break;
        }
        // Every runnable owns a different isolated worktree; a bounded wave really overlaps.
        const wave = runnable.slice(0, Math.max(1, Math.min(20, this.deps.maxParallel)));
        const settled = await Promise.allSettled(wave.map(step => this.executeNode(p, t, plan, step, job)));
        const rejected = settled.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        this.updateCursor(plan); plan.revision!++;
        await writeJson(this.file(p, t), plan); this.deps.changed(p, t);
      }
      if (job.stopped) { plan.state = 'paused'; plan.reason = 'workflow_stopped'; }
    } catch (error) {
      plan.state = job.stopped ? 'paused' : 'failed'; plan.reason = job.stopped ? 'workflow_stopped' : error instanceof AppError ? error.detail ?? error.code : 'workflow_step_failed';
    } finally { await writeJson(this.file(p, t), plan).catch(error => log.error('角色流程狀態保存失敗', error, { project: p, task: t })); }
  }
  async approveHuman(p: string, t: string, evidence: string, node?: string, revision?: number): Promise<WorkflowPlan> {
    return withFileLocks([path.join(this.deps.ws.projectDir(p), '.ai', 'workflows')], async () => {
    if (this.isBusy(p, t) || this.deps.isTaskBusy(p, t)) throw new AppError('conflict', 'workflow_busy');
    if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 10000) throw new AppError('bad_request', 'workflow_invalid');
    const plan = await this.get(p, t); const step = plan.steps.find(s => (!node || s.id === node) && plan.nodeStates![s.id!] === 'human');
    if (!step || plan.state !== 'paused' || (await this.deps.roles()).roles[step.role]?.main.cli !== HUMAN) throw new AppError('conflict', 'workflow_invalid');
    if (this.isBusy(p, t) || this.deps.isTaskBusy(p, t) || revision !== undefined && revision !== plan.revision) throw new AppError('conflict');
    plan.results.push({ step: plan.steps.indexOf(step), node: step.id!, role: step.role, ai: HUMAN, request: '', ok: true, approved: true, evidence, output: evidence, at: new Date().toISOString() });
    plan.nodeStates![step.id!] = 'succeeded'; this.updateCursor(plan); plan.revision!++; plan.state = plan.cursor === plan.steps.length ? 'completed' : 'ready'; delete plan.reason;
    await writeJson(this.file(p, t), plan); this.deps.changed(p, t); return plan;
    });
  }
  async rerun(p: string, t: string, from: number, revision?: number): Promise<WorkflowPlan> {
    return withFileLocks([path.join(this.deps.ws.projectDir(p), '.ai', 'workflows')], async () => {
    if (this.isBusy(p, t) || this.deps.isTaskBusy(p, t)) throw new AppError('conflict', 'workflow_busy');
    const plan = await this.get(p, t);
    if (this.isBusy(p, t) || this.deps.isTaskBusy(p, t) || revision !== undefined && revision !== plan.revision) throw new AppError('conflict');
    if (!Number.isSafeInteger(from) || from < 0 || from >= plan.steps.length) throw new AppError('bad_request', 'workflow_invalid');
    if (plan.results.length >= 200) throw new AppError('conflict', 'workflow_invalid');
    const affected = downstreamNodes(plan.steps, plan.steps[from]!.id!); const at = new Date().toISOString();
    for (const result of plan.results) if (affected.has(result.node ?? plan.steps[result.step ?? 0]?.id ?? '')) result.invalidatedAt ??= at;
    for (const id of affected) plan.nodeStates![id] = 'pending';
    this.updateCursor(plan); plan.revision!++; plan.state = 'ready'; delete plan.reason;
    await writeJson(this.file(p, t), plan); this.deps.changed(p, t); return plan;
    });
  }
  async stop(p: string, t: string): Promise<void> {
    const job = this.jobs.get(this.key(p, t)); if (!job) return;
    job.stopped = true;
    await Promise.all([...job.branches].map(async branch => { this.deps.stopReview(p, branch); await this.deps.runner.stop(p, branch); }));
    await job.done;
  }
  async close(): Promise<void> { await Promise.all([...this.jobs.keys()].map(key => { const [p, t] = key.split('\0'); return this.stop(p!, t!); })); }
}
