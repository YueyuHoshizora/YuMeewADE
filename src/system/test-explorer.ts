import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { VerifyService } from '../git/verify.ts';
import { verificationFingerprint } from '../git/verification-fingerprint.ts';
import type { Workspace } from '../ledger/workspace.ts';
import type { ProjectLedger } from '../ledger/projects.ts';
import type { TaskLedger } from '../ledger/tasks.ts';
import { AppError } from '../shared/errors.ts';
import { atomicWrite, isInside, withFileLocks } from '../shared/fsx.ts';
import type { TestCaseNode, TestExplorerRun, TestExplorerState, TestRunnerConfiguration } from '../shared/test-explorer.ts';
import { frameworkCommand, parseFrameworkReport } from './test-frameworks.ts';
import { parseVerificationInputModel } from '../shared/verification.ts';
import type { VerifyResult } from '../shared/types.ts';

/** Node's indented TAP: subtest declarations precede children and the parent result. */
export function parseNodeTap(output: string, root: string): TestCaseNode[] {
  const roots: TestCaseNode[] = [];
  const stack: { indent: number; node: TestCaseNode }[] = [];
  let last: TestCaseNode | undefined;
  let count = 0;
  for (const row of output.split(/\r?\n/u)) {
    const declaration = /^(\s*)# Subtest: (.*)$/u.exec(row);
    if (declaration) {
      const indent = declaration[1]!.length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      if (++count > 2000 || stack.length > 50 || declaration[2]!.length > 2000) return [];
      const parent = stack.at(-1)?.node;
      const name = declaration[2]!.slice(0, 2000);
      const node: TestCaseNode = { id: String(count), name, fullName: parent ? `${parent.fullName} ${name}` : name, status: 'unknown', children: [] };
      (parent?.children ?? roots).push(node); stack.push({ indent, node }); last = node;
      continue;
    }
    const result = /^(\s*)(not ok|ok)\s+\d+\s*(?:-\s*)?(.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/iu.exec(row);
    if (result) {
      const indent = result[1]!.length;
      while (stack.length && stack.at(-1)!.indent > indent) stack.pop();
      const candidate = stack.at(-1);
      if (candidate?.indent === indent) {
        candidate.node.status = result[4]?.toUpperCase() === 'SKIP' ? 'skipped' : result[4]?.toUpperCase() === 'TODO' ? 'todo' : result[2] === 'ok' ? 'passed' : 'failed';
        last = candidate.node; stack.pop();
      }
      continue;
    }
    if (!last) continue;
    if (/^\s+(?:error|message|failureType|code|expected|actual|operator|stack):/u.test(row) || /^\s+.*:\d+:\d+\)?\s*$/u.test(row)) last.error = ((last.error ?? '') + row.trim() + '\n').slice(0, 16000);
    const location = /(?:location:\s*['"]?|\s+at\s+(?:.*?\()?)(file:\/\/[^\s'"()]+|[^\s'"()]+):(\d+):(\d+)/u.exec(row);
    if (location) {
      let file = location[1]!;
      try { if (file.startsWith('file:')) file = fileURLToPath(file); } catch { continue; }
      const absolute = path.resolve(root, file);
      if (isInside(root, absolute)) { last.file = path.relative(root, absolute).split(path.sep).join('/'); last.line = Number(location[2]); }
    }
  }
  return roots;
}

interface Options { ws: Workspace; projects: ProjectLedger; tasks: TaskLedger; verify: VerifyService; beforeRun: (project: string) => Promise<void>; isRunning: (project: string, task: string) => boolean; }
export class TestExplorerService {
  private readonly opts: Options;
  private readonly pending = new Set<string>();
  constructor(opts: Options) { this.opts = opts; }
  isRunning(project: string, task?: string): boolean { return task === undefined ? [...this.pending].some(key => (JSON.parse(key) as string[])[0] === project) : this.pending.has(JSON.stringify([project, task])); }
  isBusy(): boolean { return this.pending.size > 0; }
  private async cwd(project: string, task: string): Promise<string> {
    this.opts.ws.taskFile(project, task);
    const [p, t] = await Promise.all([this.opts.projects.get(project), this.opts.tasks.get(project, task)]);
    const cwd = await fs.realpath(t.workdir || this.opts.projects.bodyPath(p));
    const body = await fs.realpath(this.opts.projects.bodyPath(p));
    const worktree = await fs.realpath(this.opts.ws.worktreeDir(project, task)).catch(() => null);
    if (!(cwd === body || isInside(body, cwd) || (worktree && (cwd === worktree || isInside(worktree, cwd))))) throw new AppError('bad_request');
    return cwd;
  }
  private async file(project: string, task: string, history = false): Promise<string> {
    this.opts.ws.taskFile(project, task); await this.opts.tasks.get(project, task);
    const root = await fs.realpath(this.opts.ws.projectDir(project));
    const folder = path.join(root, '.ai', history ? 'verification' : 'test-explorer');
    await fs.mkdir(folder, { recursive: true });
    if (!isInside(root, await fs.realpath(folder))) throw new AppError('bad_request');
    const file = path.join(folder, `${task}${history ? '.tests' : ''}.json`);
    const stat = await fs.lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new AppError('bad_request');
    return file;
  }
  private async read<T>(file: string, fallback: T): Promise<T> {
    const stat = await fs.stat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!stat) return fallback;
    if (stat.size > 4 * 1024 * 1024) throw new AppError('too_large');
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  }
  async state(project: string, task: string): Promise<TestExplorerState> {
    await this.cwd(project, task);
    const configurations = await this.read<TestRunnerConfiguration[]>(await this.file(project, task), []);
    const history = await this.read<TestExplorerRun[]>(await this.file(project, task, true), []);
    if (!Array.isArray(configurations) || configurations.length > 20 || !Array.isArray(history) || history.length > 20) throw new AppError('bad_request');
    return { revision: createHash('sha256').update(JSON.stringify(configurations)).digest('hex'), configurations: configurations.map(value => this.configuration(value)), history };
  }
  private configuration(value: unknown): TestRunnerConfiguration {
    if (!value || typeof value !== 'object') throw new AppError('bad_request');
    const v = value as TestRunnerConfiguration;
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80 || /[\0\r\n]/u.test(v.name) || !Array.isArray(v.files) || !v.files.length || v.files.length > 100 || v.files.some(file => typeof file !== 'string' || file.length > 4096 || !file || /^[\/-]/u.test(file) || /[\\\0\r\n*?:]/u.test(file) || file.split('/').some(part => part === '..' || part === '.git' || !part))) throw new AppError('bad_request');
    const framework = v.framework ?? 'node';
    if (!['node', 'vitest', 'jest', 'pytest', 'go'].includes(framework)) throw new AppError('bad_request');
    if (v.config !== undefined && (typeof v.config !== 'string' || !v.config || v.config.length > 4096 || /^[\/-]/u.test(v.config) || /[\\\0\r\n*?]/u.test(v.config) || v.config.split('/').some(part => part === '..' || part === '.git'))) throw new AppError('bad_request');
    if (framework === 'go' && v.config) throw new AppError('bad_request');
    return { name: v.name, files: [...new Set(v.files)], framework, ...(v.config ? { config: v.config } : {}) };
  }
  async save(project: string, task: string, value: unknown, revision: string): Promise<TestExplorerState> {
    if (this.opts.isRunning(project, task) || this.isRunning(project, task)) throw new AppError('conflict');
    const config = this.configuration(value); const root = await this.cwd(project, task);
    for (const file of [...config.files, ...(config.config ? [config.config] : [])]) {
      const real = await fs.realpath(path.resolve(root, file));
      const stat = await fs.stat(real);
      if ((real !== root && !isInside(root, real)) || !(config.files.includes(file) && (config.framework === 'go' || config.framework === 'pytest') ? stat.isFile() || stat.isDirectory() : stat.isFile())) throw new AppError('bad_request');
    }
    const file = await this.file(project, task);
    await withFileLocks([this.opts.ws.projectFile(project), file], async () => {
      const state = await this.state(project, task);
      if (revision !== state.revision) throw new AppError('conflict');
      const configs = state.configurations.filter(c => c.name !== config.name); configs.push(config);
      if (configs.length > 20) throw new AppError('unavailable');
      await atomicWrite(file, JSON.stringify(configs) + '\n'); await fs.chmod(file, 0o600);
    });
    return this.state(project, task);
  }
  /** Discovery is an explicit trusted execution; case names come only from runner reports. */
  async run(project: string, task: string, runner: string, selection?: string): Promise<TestExplorerRun> {
    const key = JSON.stringify([project, task]);
    if (this.pending.has(key) || this.opts.isRunning(project, task)) throw new AppError('conflict');
    this.pending.add(key);
    try {
      await this.opts.beforeRun(project);
      const state = await this.state(project, task); const config = state.configurations.find(c => c.name === runner);
      if (!config) throw new AppError('not_found');
      let selected: TestCaseNode | undefined;
      const matches: TestCaseNode[] = [];
      const find = (nodes: TestCaseNode[]): void => { for (const node of nodes) { if (node.fullName === selection) matches.push(node); find(node.children); } };
      if (selection) {
        find([...state.history].reverse().find(run => run.runner === runner && !run.selection)?.tree ?? []);
        // Name-filter runners cannot distinguish duplicate full names; never fake a single rerun.
        if (matches.length !== 1) throw new AppError('bad_request');
        selected = matches[0];
      }
      const root = await this.cwd(project, task);
      const projectModel = parseVerificationInputModel((await this.opts.projects.get(project)).verificationInputs);
      const configuration = JSON.stringify([config, projectModel]);
      for (const file of [...config.files, ...(config.config ? [config.config] : [])]) {
        const real = await fs.realpath(path.resolve(root, file)); const stat = await fs.stat(real);
        if ((real !== root && !isInside(root, real)) || !(config.files.includes(file) && (config.framework === 'go' || config.framework === 'pytest') ? stat.isFile() || stat.isDirectory() : stat.isFile())) throw new AppError('bad_request');
      }
      if (config.framework === 'pytest' && selected?.file) {
        const real = await fs.realpath(path.resolve(root, selected.file));
        if (!isInside(root, real) || !(await fs.stat(real)).isFile() || !config.files.some(file => file === '.' || selected.file === file || selected.file?.startsWith(`${file}/`))) throw new AppError('bad_request');
      }
      const before = await verificationFingerprint(root, configuration, projectModel);
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yumeewade-tests-'));
      let result: VerifyResult;
      let tree: TestCaseNode[] = [];
      try {
        const report = path.join(temporary, 'report');
        const argv = await frameworkCommand(root, config, report, selected);
        result = await this.opts.verify.runFrameworkTests(project, task, argv.command, argv.args);
        if (config.framework === 'pytest' && /No module named pytest/u.test(result.output)) throw new AppError('unavailable', 'cli_unavailable', { field: 'pytest' });
        if (!result.truncated && !result.timedOut) {
          if (!config.framework || config.framework === 'node') tree = parseNodeTap(result.output, root);
          else if (config.framework === 'go') {
            const module = /^\s*module\s+(\S+)/mu.exec(await fs.readFile(path.join(root, 'go.mod'), 'utf8'))?.[1];
            tree = parseFrameworkReport('go', result.output, root, module);
          }
          else {
            const stat = await fs.lstat(report).catch(() => null);
            if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024) tree = parseFrameworkReport(config.framework, await fs.readFile(report, 'utf8'), root);
          }
        }
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
      const cases: TestCaseNode[] = [];
      const collectCases = (nodes: TestCaseNode[]): void => { for (const node of nodes) { cases.push(node); collectCases(node.children); } };
      collectCases(tree);
      if (!cases.length || cases.some(node => node.status === 'unknown') || (selection && !cases.some(node => node.fullName === selection && node.status !== 'skipped'))) result.ok = false;
      const current = await this.state(project, task);
      const currentConfig = current.configurations.find(c => c.name === runner);
      const currentModel = parseVerificationInputModel((await this.opts.projects.get(project)).verificationInputs);
      const after = await verificationFingerprint(await this.cwd(project, task), JSON.stringify([currentConfig, currentModel]), currentModel).catch(() => null);
      if (result.output.length > 65536) { result.output = result.output.slice(-65536); result.truncated = true; }
      result.drifted = before !== after; if (result.drifted) result.ok = false;
      const run: TestExplorerRun = { id: randomUUID(), at: new Date().toISOString(), runner, ...(selection ? { selection } : {}), before, after, result, tree };
      const file = await this.file(project, task, true);
      await withFileLocks([this.opts.ws.projectFile(project), file], async () => {
        await this.opts.tasks.get(project, task);
        const rows = [...await this.read<TestExplorerRun[]>(file, []), run].slice(-20);
        while (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024 && rows.length > 1) rows.shift();
        if (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) throw new AppError('too_large');
        await atomicWrite(file, JSON.stringify(rows) + '\n'); await fs.chmod(file, 0o600);
      });
      return run;
    } finally { this.pending.delete(key); }
  }
}
