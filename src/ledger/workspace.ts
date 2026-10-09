// 工作區路徑配置（PLAN.md A.2）。所有台帳／對話／副本路徑都從這裡產生，名稱先過白名單再拼路徑。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.ts';
import { isInside, pathExists } from '../shared/fsx.ts';
import { isValidProjectName, isValidTaskId } from '../shared/names.ts';

export const TEMPLATES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'templates');

export class Workspace {
  readonly root: string;
  readonly projectsDir: string;
  readonly workDir: string;
  readonly rolesFile: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.projectsDir = path.join(this.root, 'Projects');
    this.workDir = path.join(this.root, 'Work');
    this.rolesFile = path.join(this.root, 'roles.yaml');
  }

  /** 建立 Projects／Work，roles.yaml 缺檔時從範本複製。 */
  async init(): Promise<void> {
    await fs.mkdir(this.projectsDir, { recursive: true });
    await fs.mkdir(this.workDir, { recursive: true });
    if (!(await pathExists(this.rolesFile))) {
      await fs.copyFile(path.join(TEMPLATES_DIR, 'roles.yaml'), this.rolesFile);
    }
  }

  projectDir(name: string): string {
    if (!isValidProjectName(name)) throw new AppError('bad_request', '專案名稱不合法');
    const dir = path.join(this.projectsDir, name);
    if (!isInside(this.projectsDir, dir)) throw new AppError('bad_request', '專案名稱不合法');
    return dir;
  }

  projectFile(name: string): string {
    return path.join(this.projectDir(name), 'PROJECT.md');
  }

  tasksDir(name: string): string {
    return path.join(this.projectDir(name), '.ai', 'tasks');
  }

  taskFile(name: string, id: string): string {
    if (!isValidTaskId(id)) throw new AppError('bad_request', '作業 ID 不合法');
    return path.join(this.tasksDir(name), `${id}.md`);
  }

  chatFile(name: string, id: string, kind: 'jsonl' | 'json' | 'queue.json'): string {
    if (!isValidTaskId(id)) throw new AppError('bad_request', '作業 ID 不合法');
    return path.join(this.projectDir(name), '.ai', 'chat', `${id}.${kind}`);
  }

  worktreeDir(name: string, id: string): string {
    if (!isValidTaskId(id)) throw new AppError('bad_request', '作業 ID 不合法');
    this.projectDir(name); // 驗證專案名
    return path.join(this.workDir, name, id);
  }
}
