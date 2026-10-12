import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { parseFrontmatter, patchHeaderLines, serializeFrontmatter } from '../shared/frontmatter.ts';
import { atomicWrite, isInside, missingAs, withFileLocks } from '../shared/fsx.ts';
import type { TaskTemplate } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';
import { parseSteps, STEP_TEXT_MAX, STEPS_MAX, TaskLedger, TITLE_MAX } from './tasks.ts';

/** A template (or its folder) deleted outside the app is simply not there. */
const notFound = missingAs(() => new AppError('not_found'));
export class TaskTemplates {
  private readonly ws: Workspace;
  constructor(ws: Workspace) { this.ws = ws; }
  private async directory(project: string, scope: 'project' | 'workspace', create = false): Promise<string> {
    const root = scope === 'workspace' ? this.ws.root : this.ws.projectDir(project);
    const dir = scope === 'workspace' ? path.join(root, 'templates') : path.join(root, '.ai', 'templates');
    if (create) {
      const parent = path.dirname(dir);
      const base = await fs.realpath(root), resolvedParent = await fs.realpath(parent);
      if (resolvedParent !== base && !isInside(base, resolvedParent)) throw new AppError('bad_request', 'field_type');
      await fs.mkdir(dir, { recursive: true });
    }
    if (!isInside(await fs.realpath(root), await fs.realpath(dir)) || (await fs.lstat(dir)).isSymbolicLink()) throw new AppError('bad_request', 'field_type');
    return dir;
  }
  private async file(project: string, scope: 'project' | 'workspace', name: string, create = false): Promise<string> {
    if (!/^[\p{L}\p{N}_-]{1,60}$/u.test(name)) throw new AppError('bad_request', 'field_type', { field: 'name' });
    const file = path.join(await this.directory(project, scope, create), `${name}.md`);
    const stat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)) throw new AppError('bad_request', 'field_type');
    return file;
  }
  async get(project: string, scope: 'project' | 'workspace', name: string): Promise<TaskTemplate> {
    const { data, body } = parseFrontmatter(await this.file(project, scope, name).then(file => fs.readFile(file, 'utf8')).catch(notFound));
    if (typeof data['title'] !== 'string' || !data['title'].trim() || data['title'].length > TITLE_MAX || (data['instruction'] !== undefined && (typeof data['instruction'] !== 'string' || data['instruction'].length > 10000))) throw new AppError('bad_request', 'field_type');
    // The same bounds TaskLedger.create applies: a listed template must be able to create a task.
    const steps = parseSteps(body).map(step => step.text);
    if (steps.length > STEPS_MAX || steps.some(step => step.length > STEP_TEXT_MAX)) throw new AppError('bad_request', 'field_type');
    return { name, scope, title: data['title'], instruction: typeof data['instruction'] === 'string' ? data['instruction'] : '', steps };
  }
  async list(project: string): Promise<TaskTemplate[]> {
    const rows: TaskTemplate[] = [];
    for (const scope of ['project', 'workspace'] as const) {
      let names: string[];
      try { names = await fs.readdir(await this.directory(project, scope)); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
      for (const file of names.filter(name => name.endsWith('.md')).sort().slice(0, 200)) {
        try { rows.push(await this.get(project, scope, file.slice(0, -3))); } catch { /* 手工範本的錯誤不妨礙其他範本。 */ }
      }
    }
    return rows;
  }
  async saveFromTask(project: string, task: string, name: string, instruction: string, scope: 'project' | 'workspace'): Promise<TaskTemplate> {
    if (typeof instruction !== 'string' || instruction.length > 10000) throw new AppError('bad_request', 'field_type', { field: 'instruction' });
    const file = await this.file(project, scope, name, true);
    return withFileLocks([this.ws.projectFile(project), file], async () => {
      const source = await new TaskLedger(this.ws).get(project, task);
      if (source.steps.length > STEPS_MAX || source.steps.some(step => step.text.length > STEP_TEXT_MAX) || source.title.length > TITLE_MAX) throw new AppError('bad_request', 'field_type');
      try { await fs.lstat(file); throw new AppError('conflict'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      const text = serializeFrontmatter(patchHeaderLines([], { title: source.title, instruction }), `## 步驟\n${source.steps.map(step => `- [ ] ${step.text}`).join('\n')}\n`);
      if (Buffer.byteLength(text, 'utf8') > 65536) throw new AppError('bad_request', 'field_type');
      await atomicWrite(file, text);
      return this.get(project, scope, name);
    });
  }
  async remove(project: string, scope: 'project' | 'workspace', name: string): Promise<void> {
    const file = await this.file(project, scope, name).catch(notFound);
    await withFileLocks([this.ws.projectFile(project), file], async () => { await fs.unlink(file).catch(notFound); });
  }
}
